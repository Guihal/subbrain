# M-03 · Salience + reinforce-on-access + night-cycle decay

**Tier:** P1 · **Effort:** M · **Deps:** M-02 (access tracking) — landed · **Status:** DONE
**Migration assignment:** **13** (M-05 takes 14 — do NOT use 14 here even if file ordering suggests it).

## Цель

M-02 положил `last_accessed_at` + `access_count`. Это сигналы, но retrieval их пока не использует. M-03 добавляет **salience** — popularity/importance score, который крепнет при каждом use'е и затухает в night-cycle.

После M-03:
- Колонка `salience REAL NOT NULL DEFAULT 0.5` на `shared_memory` / `layer2_context` / `layer3_archive` (тот же 3-layer scope что у M-02).
- На каждый RAG hit (после rerank) `bumpAccess` дополнительно делает `salience = MIN(1.0, salience + 0.05 * exp(-age_days/7))`. То есть свежие memos получают полный bonus, старые — экспоненциально меньший.
- Night-cycle step `decay-salience.ts` раз в сутки: `salience = salience * 0.98^days_since_last_access` для всех rows where last_accessed_at IS NOT NULL.
- RAG rerank score blends `final = sim_score * (1 + 0.1 * salience)` (лёгкий +10% boost при salience=1.0; тюнингуем после A/B). Не доминирует над cosine; signal, не override.
- Persona boost (M-07) и salience boost комбинируются мультипликативно — persona+salient row получает (1+0.1) * (1+0.1) ≈ +21%.

Foundation для **M-08** (Ebbinghaus forgetting curve — salience входит в score формулу `R = exp(-Δt / S)` где `S` зависит от access_count и salience).

## Файлы (scope-lock)

- `packages/core/packages/core/packages/core/src/db/schema.ts` — Migration **13** (assigned). `ALTER TABLE … ADD COLUMN salience REAL NOT NULL DEFAULT 0.5` на 3 таблицы. Idempotent (дублирующая колонка → catch). `db.transaction()` + per-statement `.run()`.
- `packages/core/packages/core/packages/core/src/db/types.ts` — `salience?: number` на `SharedRow` / `ContextRow` / `ArchiveRow`. Optional т.к. legacy SELECTs могут не запросить.
- `packages/core/src/repositories/memory.repo.ts` — расширить `bumpAccess(layer, ids)` чтобы UPDATE дополнительно обновлял `salience`. Использовать SQL CASE для bonus формулы:
  ```sql
  UPDATE <table>
     SET last_accessed_at = ?,
         access_count = access_count + 1,
         salience = MIN(1.0, salience + 0.05 * EXP(-(? - COALESCE(last_accessed_at, ?)) / (7.0 * 86400)))
   WHERE id IN (?,?,…)
  ```
  Note: если `last_accessed_at` был NULL (первый hit) — age = 0 → bonus полный (0.05). Параметры: now, now (для COALESCE fallback на now → age=0).
- `packages/agent/packages/agent/packages/agent/packages/agent/src/pipeline/night-cycle/steps/decay-salience.ts` — **NEW** файл (≤100 LOC). Step класса `NightCycleStep` (если есть базовый интерфейс — match'ить). Выполняет на 3 таблицах:
  ```sql
  UPDATE <table>
     SET salience = salience * POW(0.98, (? - last_accessed_at) / 86400.0)
   WHERE last_accessed_at IS NOT NULL
     AND salience > 0.001
  ```
  `0.001` — floor чтобы не плодить epsilon-rows. `now` пробрасывается параметром. Никакого LLM-вызова (это чистая SQL-step).
- `packages/agent/packages/agent/packages/agent/packages/agent/src/pipeline/night-cycle/steps/index.ts` — добавить `decaySalience` в order, после `runMemoryDedup` (соседство со step'ами которые трогают memory rows).
- `packages/agent/packages/agent/src/rag/pipeline/index.ts` — в rerank-score функции (после persona boost от M-07): `score *= (1 + 0.1 * (r.salience ?? 0.5))`. Optional поле — context/archive/shared всегда имеют salience после mig 13; default 0.5 если undefined.
- `packages/core/src/db/tables/{shared,memory}.ts` (если SELECT-list явный) — добавить `salience` колонку. Если `SELECT *` — пропустить.
- `tests/memory-salience.test.ts` — **NEW** файл. ≤200 LOC.
- `docs/02-audit.md` — добавить `### MEM-10 ✅ salience reinforce + decay (закрыто M-03)`.
- `docs/tasks/memory-v2/M-03-salience.md` (этот) — Status DONE.

**НЕ трогать:**
- Существующие миграции 1-12.
- `bumpAccess` сигнатуру: всё ещё `(layer, ids[])` — внутрь добавляются доп. колонки.
- M-02 access tracking тесты.
- M-07 persona boost (M-03 не меняет, лишь добавляет multiplicative factor).

## Изменение

### Migration 13

Pattern matches mig 10/12 (additive ALTER ADD + try/catch на duplicate). 3 ALTER + 1 PRAGMA. Никаких индексов на salience пока — query'и ORDER BY salience DESC если будут понадобиться, добавим в M-04.1.

### Reinforce formula

`salience += 0.05 * exp(-age_days/7)` где age_days = `(now - last_accessed_at) / 86400`. SQLite не имеет встроенной EXP() в стандартной сборке, но **bun:sqlite** загружает math extensions. Если EXP() недоступна — fallback на пиecewise approximation:
```sql
CASE
  WHEN (?-last_accessed_at) < 86400      THEN salience + 0.05
  WHEN (?-last_accessed_at) < 7*86400    THEN salience + 0.025
  WHEN (?-last_accessed_at) < 30*86400   THEN salience + 0.01
  ELSE salience + 0.001
END
```
Subagent: проверить bun:sqlite EXP() поддержку через `SELECT EXP(0)`. Если работает — формула. Если нет — piecewise.

### Decay formula

`salience *= 0.98^days_since_access`. Аналогично — POW() / piecewise по day-buckets (1d, 7d, 30d, ...). Идемпотентно (запуск 2 раза подряд = декей применён 2 раза, что корректно отражает прошедшее время... только если `last_accessed_at` не обновился между запусками — нет, формула использует `(now - last_accessed_at)`, поэтому 2 декея на одну запись с теми же датами дадут double-decay. **Чтобы избежать double-decay** — после step'а апдейтить `last_accessed_at = now`? Это испортит signal (мы не хотим pretend что row был accessed когда он не был).

**Решение:** ввести отдельную колонку `last_decayed_at` ИЛИ хранить salience-snapshot delta. Простейший путь — **idempotent decay вычисляется относительно `last_decayed_at`**:
- Migration 13 также добавляет `last_decayed_at INTEGER DEFAULT NULL` (4-я колонка).
- Step делает: `salience *= 0.98^days_since(last_decayed_at)` затем `last_decayed_at = now`. Первый run после migration: `last_decayed_at IS NULL` → use last_accessed_at as proxy (or skip first run, just set last_decayed_at = now).

Subagent волен выбрать (простейший рабочий путь):
1. **Path A:** добавить `last_decayed_at`, использовать для decay rate, обновлять в конце step'а.
2. **Path B:** отказаться от idempotent decay в этом тикете → step запускается строго раз в сутки (idempotency guard на уровне night-cycle scheduler). Если scheduler перепустит = двойной decay (неприятно но не катастрофа). Менее robust.

Рекомендую Path A. Migration 13 = 4 колонки (salience + last_decayed_at × 3 layers).

### RAG rerank score

В `rag/pipeline.ts` rerank-scoring (рядом с persona boost от M-07):
```ts
const SALIENCE_BOOST_FACTOR = 0.1; // tunable; small initial value
// after rerank score computed:
const salience = r.salience ?? 0.5;
score *= (1 + SALIENCE_BOOST_FACTOR * salience);
```
Combine с persona-boost (M-07: `if persona → score *= 1.1`). Итоговое умножение порядка ≤1.21.

`RAGResult.salience?: number` в `rag/types.ts`. Если context/archive/shared SELECTs не возвращают salience — fallback 0.5 (default).

## Тесты

`tests/memory-salience.test.ts` (`bun:test`, `data/test-mem3-salience.db`):

1. **Migration 13: salience + last_decayed_at columns + idempotency.**
2. **`bumpAccess` reinforces salience:** insert row с salience=0.5; 3 hits подряд → salience > 0.5 (но < 1.0). Старая row (last_accessed_at = 90d ago) → bonus малый (formulaically expected via age decay).
3. **`bumpAccess` saturates at 1.0:** 100 hits подряд → salience capped at 1.0.
4. **Decay step decreases salience:** insert row salience=1.0, last_decayed_at = 10d ago → run step → salience ≈ 1.0 * 0.98^10 ≈ 0.817.
5. **Decay step idempotent:** запустить 2 раза подряд (между ними `last_decayed_at` уже обновлён) → второй запуск decay = 0 (т.к. age=0).
6. **Decay floor:** salience < 0.001 → step не трогает (skip via WHERE salience > 0.001).
7. **RAG rerank uses salience:** seed 2 rows одинакового FTS score; bumped row salience=0.9 vs untouched salience=0.5 → bumped ranks higher.
8. **Persona + salience compound:** persona row (M-07 kind='persona', boost 1.1) + high salience (boost 1.09) → final boost ~1.2× over base.

## Приёмка (machine-checkable)

1. `bunx tsc --noEmit` → exit 0.
2. `bun test tests/memory-salience.test.ts` → all green.
3. `bun test` → ≥678 pass, 0 fail.
4. `sqlite3 <db> "PRAGMA table_info(shared_memory);"` → `salience` (REAL, NOT NULL, default 0.5) + `last_decayed_at` (INTEGER, default NULL).
5. `grep -n "salience" packages/core/src/repositories/memory.repo.ts packages/agent/packages/agent/src/rag/pipeline/index.ts packages/agent/packages/agent/packages/agent/src/pipeline/night-cycle/steps/decay-salience.ts` → ≥3 hits.
6. `docs/tasks/memory-v2/M-03-salience.md` Status: DONE.

## Out of scope

- Salience-based pruning (don't auto-delete low-salience).
- Per-kind salience asymmetry (persona never decays — M-08).
- Tuning constants (0.05/0.98/0.1) — A/B follow-up.
- agent_memory salience (out — kind only on shared в M-07; salience ставим для retrieval-bound layers).

---

**Status:** DONE
