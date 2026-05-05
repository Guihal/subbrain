# M-07 · Memory type/persona enum (`kind`)

**Tier:** P1 · **Effort:** S · **Deps:** — · **Status:** DONE (commit `1eeb472` direct on main; subagent-process anomaly required rescue, see commit body)
**Migration assignment:** **12** (M-04 takes 11 — do NOT use 11 here).

## Цель

Сейчас `shared_memory` смешивает personality-факты (profile / preference / relationship) с semantic-фактами (goal / skill / constraint / style) в одной плоской таблице. Нет способа отличить "Дмитрий любит Hyprland" (persona, **очень** высокий приоритет в системном промпте) от "TypeScript строгая типизация важнее DX" (semantic, средний приоритет).

После M-07: новая колонка `kind TEXT CHECK(kind IN ('persona','semantic','episodic','procedural'))` на `shared_memory`. Маршрутизация на insert через `validators.ts`. RAG retrieval даёт `+0.1` rerank-boost для `kind='persona'`. UI `/memory` страница получает фильтр по kind.

Foundation для **M-08** (forgetting curve — persona никогда не "забывается", semantic decay'ятся быстро) и **M-11** (sleep-time block rewriter — переписывает persona-блоки в layer1_focus).

## Файлы (scope-lock)

- `packages/core/packages/core/packages/core/src/db/schema.ts` — Migration **12** (assigned). `ALTER TABLE shared_memory ADD COLUMN kind TEXT NOT NULL DEFAULT 'semantic'` + backfill UPDATE по category mapping (см. ниже) + CHECK-constraint через trigger (SQLite ALTER не поддерживает ADD CHECK напрямую).
- `packages/core/packages/core/packages/core/src/db/types.ts` — `kind: 'persona' | 'semantic' | 'episodic' | 'procedural'` на `SharedRow` (NOT optional — NOT NULL DEFAULT в схеме).
- `packages/agent/packages/agent/packages/agent/packages/agent/src/pipeline/agent-pipeline/post/validators.ts` — добавить функцию `categoryToKind(category: string, layer: 'shared' | 'context'): MemoryKind`. Маршрутизация:
  - shared.profile / preference / relationship → `persona`
  - shared.goal / skill / constraint / style → `semantic`
  - context.* → не используется (kind остаётся только на shared в M-07)
  - default → `semantic`
- `packages/agent/packages/agent/packages/agent/packages/agent/src/pipeline/agent-pipeline/post/extractors.ts` — `writeShared` пробрасывает `kind` в `MemoryService.insertShared`.
- `packages/agent/src/services/memory.service.ts` — `insertShared` принимает optional `kind?: MemoryKind`; default `'semantic'`. Прокидывается в `repo.insertShared` → `db/tables/shared.ts`.
- `packages/core/src/repositories/memory.repo.ts` — расширить сигнатуру.
- `packages/core/src/db/tables/shared.ts` — `insertShared` принимает `kind`; SELECT-list (если явный) расширить.
- `packages/agent/packages/agent/src/rag/pipeline/index.ts` — в rerank scoring (или recency-boost функции) добавить `if (r.layer === 'shared' && r.kind === 'persona') score *= 1.1`. Тип `RAGResult` расширить `kind?: string` (optional т.к. context/archive/log не имеют поля).
- `packages/server/packages/server/packages/server/src/routes/memory.ts` — `GET /v1/memory/shared` принять опциональный `?kind=persona` query-param (TypeBox enum). Применить в SELECT.
- `web/app/composables/useMemory.ts` — добавить `kind` в shared filter state.
- `web/app/pages/memory.vue` — kind dropdown на shared tab (`<select>` с 4 опциями + "all").
- `tests/memory-kind.test.ts` — **NEW** файл.
- `docs/02-audit.md` — добавить `### MEM-9 ✅ memory kind/persona (закрыто M-07)`.
- `docs/tasks/memory-v2/M-07-memory-kind.md` — Status: DONE.

**НЕ трогать:**
- Миграции 1-11 (M-04 берёт 11).
- `WHITELIST_SHARED` / `WHITELIST_CONTEXT` constants — M-07 НЕ меняет таксономию категорий, только маппит на kind.
- `layer2_context` / `layer3_archive` — kind only on shared.
- agent_memory.

## Изменение

### Migration 12

```sql
ALTER TABLE shared_memory ADD COLUMN kind TEXT NOT NULL DEFAULT 'semantic';
-- Backfill from category (case-insensitive, NULL category → keep default 'semantic'):
UPDATE shared_memory
   SET kind = CASE LOWER(category)
                WHEN 'profile' THEN 'persona'
                WHEN 'preference' THEN 'persona'
                WHEN 'relationship' THEN 'persona'
                ELSE 'semantic'
              END;
-- CHECK via trigger (SQLite ALTER cannot ADD CHECK):
CREATE TRIGGER IF NOT EXISTS trg_shared_kind_check
  BEFORE INSERT ON shared_memory
  WHEN NEW.kind NOT IN ('persona','semantic','episodic','procedural')
  BEGIN
    SELECT RAISE(ABORT, 'invalid kind');
  END;
CREATE TRIGGER IF NOT EXISTS trg_shared_kind_check_upd
  BEFORE UPDATE OF kind ON shared_memory
  WHEN NEW.kind NOT IN ('persona','semantic','episodic','procedural')
  BEGIN
    SELECT RAISE(ABORT, 'invalid kind');
  END;
CREATE INDEX IF NOT EXISTS idx_shared_kind ON shared_memory(kind);
PRAGMA user_version = 12;
```

`db.transaction()` + per-statement `.run()`. Идемпотентность: `user_version < 12` guard + try/catch на duplicate-column-name (как M-02 mig 10).

### `categoryToKind` helper

```ts
// packages/agent/packages/agent/packages/agent/src/pipeline/agent-pipeline/post/validators.ts
export type MemoryKind = 'persona' | 'semantic' | 'episodic' | 'procedural';

const PERSONA_CATEGORIES = new Set(['profile', 'preference', 'relationship']);

export function categoryToKind(category: string, layer: 'shared' | 'context'): MemoryKind {
  if (layer !== 'shared') return 'semantic';
  if (PERSONA_CATEGORIES.has(category.toLowerCase())) return 'persona';
  return 'semantic';
}
```

`extractors.ts` зовёт `categoryToKind(category, 'shared')` перед `MemoryService.insertShared({ ..., kind })`.

### RAG persona boost

В `rag/pipeline.ts` rerank-scoring (или в `applyRecencyBoost` / эквивалент):
```ts
const PERSONA_BOOST = 1.1;
// after rerank score is computed:
if (r.layer === 'shared' && r.kind === 'persona') {
  score *= PERSONA_BOOST;
}
```
`RAGResult.kind` — optional string. Helper `getShared(id)` возвращает row с kind; pipeline'у нужно его пробросить через FtsResult/VecResult → final RAGResult (расширить shape).

### Admin route filter

`GET /v1/memory/shared?kind=persona&page=1&pageSize=20`:
- TypeBox: `t.Optional(t.Union([t.Literal('persona'), t.Literal('semantic'), t.Literal('episodic'), t.Literal('procedural')]))`
- Если задан — `WHERE kind = ?` в SELECT.

### UI

`<select v-model="kindFilter">` с опциями `all / persona / semantic / episodic / procedural`. На change — refetch shared list с `?kind=`.

## Тесты

`tests/memory-kind.test.ts`:

1. **Migration 12 applies + backfill** — pre-seed `shared_memory` row с category='profile'; после миграции `kind='persona'`. Row с category='goal' → `kind='semantic'`. Row с category=NULL или unknown → `kind='semantic'`.
2. **Migration is idempotent** — re-open БД 2 раза, не throw'ит, kind значения те же.
3. **`categoryToKind` mapping** — pure-fn unit test: profile/preference/relationship → persona; goal/skill/constraint/style → semantic; context layer → всегда semantic.
4. **CHECK trigger blocks invalid kind** — `INSERT INTO shared_memory(... kind='invalid' ...)` → throws "invalid kind".
5. **`MemoryService.insertShared({ kind })` persists kind** — service-call с `kind: 'persona'` → SELECT возвращает persona.
6. **Hippocampus `extractors.writeShared` derives kind from category** — call writeShared с category='profile' → SELECT row → `kind='persona'`. category='goal' → `kind='semantic'`.
7. **RAG persona boost in rerank** — insert 2 shared rows: A category='profile' (persona), B category='goal' (semantic), оба матчатся одинаковым query → A ранжирован выше B (persona +10% boost).
8. **`GET /v1/memory/shared?kind=persona` filters** — insert mix; запрос с kind=persona возвращает только persona rows.

## Приёмка (machine-checkable)

1. `bunx tsc --noEmit` → exit 0.
2. `bun test tests/memory-kind.test.ts` → all green.
3. `bun test` → exit 0, ≥650 pass (baseline после M-02), 0 fail.
4. `sqlite3 <db> "PRAGMA table_info(shared_memory);"` → новая колонка `kind` (TEXT, NOT NULL, default `'semantic'`).
5. `sqlite3 <db> "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_shared_kind%'"` → 2 rows.
6. `sqlite3 <db> "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_shared_kind'"` → 1 row.
7. `grep -n "categoryToKind\|MemoryKind" packages/agent/packages/agent/src/pipeline/agent-pipeline/post/{validators,extractors}.ts` → ≥3 hits.
8. `grep -n "PERSONA_BOOST\|kind === 'persona'" packages/agent/packages/agent/src/rag/pipeline/index.ts` → ≥1 hit, в rerank-scoring блоке.
9. `docs/tasks/memory-v2/M-07-memory-kind.md` — Status: DONE.

## Риск + mitigations

- **Migration race с M-04** — обе мигрируют. Числа фиксированы планом (M-04=11, M-07=12). Merge в любом порядке, оба touch разные таблицы (`layer4_log` для FTS vs `shared_memory` для kind). Conflict-проблем нет.
- **CHECK через trigger vs schema** — SQLite не позволяет ALTER ADD CHECK. Trigger-вариант ловит invalid INSERTs; для UPDATE того же поля — отдельный trigger. Acceptable.
- **Backfill на больших БД** — UPDATE на 100k rows = ~1s. Acceptable одноразово.
- **`RAGResult.kind` shape change** — пробросить optional поле, существующие consumer'ы безопасны (читают только id/content/score). Новый поле не breaking.
- **Persona boost мажет ranking** — 1.1× умеренно. Не вводить >1.5 без A/B (M-08 будет тюнинг).

## Out of scope

- `kind='episodic'` / `'procedural'` writers — M-07 даёт enum + persona/semantic mapping; episodic = future для context-layer (M-06 reflect step), procedural = code-tools / skills (отдельная подсистема).
- Migration на context/archive `kind` — out (M-07 only on shared).
- Decay асимметричный по kind (persona never expires) — M-08.
- UI accept/reject persona-classification (admin override) — M-07.1 follow-up.

---

**Status:** DONE
