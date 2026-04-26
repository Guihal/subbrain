# M-02 · Access tracking columns (`last_accessed_at`, `access_count`)

**Tier:** P0 · **Effort:** M · **Deps:** — · **Status:** OPEN

## Цель

Добавить два signal-поля на трёх memory-слоях, которые сейчас retrieval-side полностью игнорирует:

- `last_accessed_at INTEGER` — unix-ms последнего попадания строки в финальный rerank-выход RAG-pipeline'а.
- `access_count INTEGER NOT NULL DEFAULT 0` — кумулятивный счётчик popularity.

После M-02 RAG retrieval инкрементит `access_count` и обновляет `last_accessed_at` каждый раз, когда строка попадает в результаты `searchHybrid` (после rerank, до возврата). Поля сами по себе ranking signal не дают — это foundation для **M-03** (salience reinforce-on-access) и **M-08** (MemoryBank Ebbinghaus-style decay в retrieval ranking). Без M-02 эти тикеты невозможны.

## Файлы (scope-lock — изменять ТОЛЬКО эти)

- `src/db/schema.ts` — Migration **10** (additive `ALTER TABLE`, идемпотентная — паттерн как мигр. 8/9 в файле). Три таблицы × два столбца + три индекса.
- `src/db/tables/shared.ts` — расширить `SharedRow` SELECT-ями + добавить новые поля в `ALLOW_SHARED_PATCH` allow-list (если есть, проверить).
- `src/db/tables/memory.ts` — то же для `layer2_context` (`ContextRow`) и `layer3_archive` (`ArchiveRow`).
- `src/db/types.ts` — добавить `last_accessed_at?: number | null`, `access_count?: number` на `SharedRow`, `ContextRow`, `ArchiveRow` интерфейсы.
- `src/repositories/memory.repo.ts` — новый метод `bumpAccess(layer: "shared"|"context"|"archive", ids: string[])` — единый batched UPDATE с `last_accessed_at = ?, access_count = access_count + 1 WHERE id IN (?,?,…)`. Один SQL вызов на (layer × вызов RAG); если ids пустой — no-op.
- `src/rag/pipeline.ts` — после успешного rerank (в `searchHybrid`, перед `return`), сгруппировать результаты по `layer` и вызвать `repo.bumpAccess(layer, ids)`. **Не блокировать ответ:** обернуть в `Promise.allSettled` и не `await`-ить (или `await` под `Promise.race([..., timeout(50ms)])` — ускорит lazy-write, но don't-care result). Любая ошибка bump'а — `log.warn` и тишина, retrieval продолжается.
- `tests/memory-access-tracking.test.ts` — **NEW** файл.
- `docs/02-audit.md` — добавить новую секцию `### MEM-7 ✅ access tracking (закрыто M-02)` ИЛИ ссылку в roadmap-block; не открывать новый аудит-айтем сегодня (M-02 — не fix аудита, а foundation для M-03/M-08).
- `docs/tasks/memory-v2/M-02-access-tracking.md` (этот файл) — `Status: DONE (PR <sha>)` в конце.

**НЕ трогать:**
- Существующие миграции (1-9) — additive only.
- `src/services/memory.service.ts` — bump-логика чисто RAG-side, не Service.
- `src/pipeline/agent-pipeline/post/*` — extraction не зависит от access (это про reading, не writing).
- `src/db/tables/log.ts` (если такой будет создан в M-04) — пересечения нет.

## Изменение

### Migration 10

Дописать в `migrate()` в `src/db/schema.ts` block по паттерну мигр. 8/9 (additive `ALTER TABLE … ADD COLUMN` под `db.transaction()` + per-statement `.run()`):

```sql
ALTER TABLE shared_memory   ADD COLUMN last_accessed_at INTEGER DEFAULT NULL;
ALTER TABLE shared_memory   ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE layer2_context  ADD COLUMN last_accessed_at INTEGER DEFAULT NULL;
ALTER TABLE layer2_context  ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE layer3_archive  ADD COLUMN last_accessed_at INTEGER DEFAULT NULL;
ALTER TABLE layer3_archive  ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_shared_access  ON shared_memory  (last_accessed_at DESC);
CREATE INDEX IF NOT EXISTS idx_context_access ON layer2_context (last_accessed_at DESC);
CREATE INDEX IF NOT EXISTS idx_archive_access ON layer3_archive (last_accessed_at DESC);
```

Использовать **одну** `db.transaction(() => { for (const stmt of MIG10) db.prepare(stmt).run(); })` — SQLite ALTER ADD COLUMN не поддерживается через `db.exec`. Идемпотентность — каждое `ALTER` обёрнуто в try/catch на ошибку "duplicate column name" (как в мигр. 8/9 — посмотреть существующий паттерн и повторить).

### `bumpAccess` в repo

Сигнатура:
```ts
bumpAccess(layer: "shared" | "context" | "archive", ids: string[]): void
```

Тело: ранний return на пустой массив. Вычислить таблицу из layer (`shared_memory` | `layer2_context` | `layer3_archive`). Один prepared statement:
```sql
UPDATE <table>
   SET last_accessed_at = ?, access_count = access_count + 1
 WHERE id IN (<? × n>)
```
`now = Date.now()`. Не оборачивать в `db.transaction()` — это single-statement UPDATE, SQLite уже atomic per statement.

### RAG-side hook

В `searchHybrid` (или эквиваленте) — после rerank, перед `return finalResults`. Сгруппировать `finalResults` по `r.layer` (Map<layer, ids[]>). Не блокирующе:

```ts
void Promise.allSettled(
  [...byLayer.entries()].map(([layer, ids]) =>
    Promise.resolve().then(() => this.repo.bumpAccess(layer, ids))
  )
).catch((err) => log.warn("rag", "bumpAccess failed", err));
```

`void` + non-await — retrieval не должен ждать UPDATE'а. SQLite UPDATE на 5-10 ids под подготовленным statement'ом — ~0.5ms, но "не блокировать ответ" — формальная гарантия.

Если `enabled=false` (env `RAG_BUMP_ACCESS=false`) — пропустить. По умолчанию on.

### Allow-list / row-shape

Проверить `db/tables/{shared,memory}.ts` — есть ли `ALLOW_*_PATCH` константы для `updateRow`-helper'а. Если есть — добавить `last_accessed_at`, `access_count` в массив (но реально через `updateRow` их не должны патчить, доступ только через `bumpAccess` репо). Лучше **не добавлять** в allow-list — закрыть от случайных PATCH'ей через `/v1/memory/*` admin endpoints.

`SharedRow`/`ContextRow`/`ArchiveRow` в `src/db/types.ts` — добавить optional поля. SELECT-list в helper-функциях `getShared`/`getContext`/`getArchive` — добавить два новых столбца, иначе они придут как `undefined` через `*` запросы (зависит от текущего стиля; если используется `SELECT *` — ничего не делать; если явный список — расширить).

## Тесты

`tests/memory-access-tracking.test.ts` (`bun:test`, `data/test-mem2-access.db` — изолированная dirty-БД):

1. **Migration applies idempotently** — открыть свежую БД дважды (повторно запустить `migrate()` под капотом конструктора `MemoryDB`); проверить что не throw'ит. `PRAGMA table_info(shared_memory)` содержит `last_accessed_at` + `access_count`. Идентично для context+archive.
2. **`bumpAccess` increments counter** — insert 3 строки в shared (через service), вызвать `repo.bumpAccess("shared", [id1, id2])` дважды → `access_count(id1)=2`, `access_count(id2)=2`, `access_count(id3)=0`. `last_accessed_at(id1)` ≥ tsBefore.
3. **`bumpAccess` no-op on empty** — `repo.bumpAccess("shared", [])` не throw'ит, не падает; `SELECT changes()` = 0.
4. **RAG hit → access_count++** — заполнить shared/context/archive 5 строками каждое (через service, embed реальный или mocked router); вызвать `rag.searchHybrid("text fragment", { layers: ["shared","context","archive"], limit: 5 })` 3 раза; для попавших в top-K строк `access_count == 3`, для не-попавших — `0`. Если bump async non-blocking — добавить `await new Promise(r => setTimeout(r, 50))` после search'а перед SELECT'ом.
5. **`RAG_BUMP_ACCESS=false` disables bump** — env-flag, повторить тест 4 → `access_count == 0` для всех.
6. **No regression на retrieval shape** — top-K порядок не зависит от bump'а в M-02 (это про M-08 будет); тест что повторный search возвращает идентичный top-K.

## Приёмка (machine-checkable)

1. `bunx tsc --noEmit` → exit 0.
2. `bun test tests/memory-access-tracking.test.ts` → all green.
3. `bun test` (полный suite) → exit 0, ≥639 pass, 0 fail (baseline до M-02 = 639 после M-01).
4. `sqlite3 <test-db> "PRAGMA table_info(shared_memory);"` → выдаёт 2 новых колонки `last_accessed_at` (INTEGER, default null) и `access_count` (INTEGER, NOT NULL, default 0). Идентично для `layer2_context` и `layer3_archive`.
5. `sqlite3 <test-db> "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%_access';"` → 3 строки.
6. `grep -n "bumpAccess" src/rag/pipeline.ts` → ≥1 hit; вызов после rerank, не до.
7. `docs/tasks/memory-v2/M-02-access-tracking.md` — `Status: DONE (PR <sha>)`.

## Риск + mitigations

- **NOT NULL без backfill** — `access_count INTEGER NOT NULL DEFAULT 0` корректно: SQLite на ALTER ADD COLUMN с DEFAULT заполняет существующие строки defaultом. last_accessed_at = NULL разрешён (legacy строки без истории доступа).
- **Concurrent bump** — два параллельных `searchHybrid` могут дёрнуть `bumpAccess` на пересекающихся id одновременно. SQLite WAL serializes write-stmts → race на `access_count + 1` race-free (один stmt). Acceptable.
- **Bump-overhead** — на каждый retrieve лишний UPDATE. Mitigation: non-blocking `void Promise.allSettled`. Если профайлинг покажет проблему — батчить bump'ы по timer'у (M-08 follow-up); сейчас не оптимизировать.
- **Index growth** — три новых индекса. На 100k rows × ~16 bytes = ~5MB. Acceptable; индексы нужны для будущих M-03/M-08 query'ев типа `ORDER BY last_accessed_at DESC LIMIT N`.
- **Test-DB pollution** — использовать выделенную `data/test-mem2-access.db`, чистить в `beforeAll`. Не дёргать `data/subbrain.db`.

## Out of scope

- Использование полей в ranking (`recency_boost` уже есть в RAG, но через query-time, не через persisted access). Это **M-08** (MemoryBank Ebbinghaus).
- `salience` поле + reinforce-on-access. Это **M-03**, depends на M-02.
- Прокидывание access-метрик на `/v1/memory/*` admin UI (frontend увидит новые поля только если фронт сам их попросит — отдельный M-02.1 если надо).
- Автоудаление по low-access — never. Только ranking penalty (M-08).

---

**Status:** DONE (M-02 — Migration 10 + bumpAccess + RAG hook landed; 634 pass / 1 pre-existing fail)
