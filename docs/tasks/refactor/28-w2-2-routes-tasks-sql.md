# 28-W2-2 — `routes/tasks.ts` SQL → repo + ≤150

**Status:** DONE (2026-04-28). Master: [28-file-size-150-limit.md](28-file-size-150-limit.md) Wave 2. Final: routes/tasks.ts 228→139, db/tables/tasks.ts 259→292 (whitelist 260→293), `TaskRepository` created.

## Цель

Убрать raw SQL (2 запроса в `buildHistoryLoader`) из `packages/server/src/routes/tasks.ts` + ужать файл с 228 до ≤150 LOC. SoC: routes — view layer.

## Файлы

**Изменить**:
- `packages/server/src/routes/tasks.ts` (228 → ≤150) — оставить только Elysia route definitions + TypeBox схемы + 2 helper response функции (`notFound`, `badTransition`). `buildHistoryLoader` + `DigestRow` уехал в repo/service. Никаких `memory.db.query(...)`.
- `packages/core/src/db/tables/tasks.ts` (260 LOC, в whitelist) — добавить 2 метода:
  - `searchTaskDigests(sinceUnix, limit, offset): TaskDigestRow[]` — query `layer3_archive WHERE tags LIKE 'tasks,digest,%' AND created_at >= ?`.
  - `countTaskDigestsSince(sinceUnix): number`.
  - **Внимание**: эти queries обращаются к `layer3_archive` — кросс-таблица. Это OK если они физически живут в `tasks.ts` (data layer can read any table). Альтернатива — методы в `db/tables/archive.ts` если такая таблица отдельно есть. Проверить структуру; если `layer3_archive` уже в memory.ts → лучше методы туда.

**Создать**:
- `packages/core/src/repositories/task.repo.ts` — пробросить методы tasks из `db/tables/tasks.ts` (включая 2 новых) + `buildHistoryLoader(scope, sinceUnix)` (page-loader для `paginate()`). 

**Сохранить**:
- `packages/agent/src/services/*` — не трогать (если task service отсутствует — route → repo допустим).
- `packages/core/src/db/index.ts` facade — тех методов, что route уже использует (`listTasks`, `insertTask`, `getTask`, `updateTask`, `transitionTask`, `deleteTask`, `transaction`, `listCompletedTasksSince`).

**Trigger**: `tests/repo-rules.test.ts` `TRANSITIONAL_SQL_ROUTES` Set — удалить `"packages/server/src/routes/tasks.ts"`.
**Trigger**: `scripts/check-file-size.ts` `"packages/server/src/routes/tasks.ts": 229` → удалить.

## Изменение

1. Добавить queries в `packages/core/src/db/tables/tasks.ts` (если layer3_archive там доступен) ИЛИ в `packages/core/src/db/tables/memory.ts` (если archive там) — следовать существующей структуре. Из локализации schema.ts видно, layer3_archive — отдельный domain; вероятно `tables/memory.ts` или `tables/shared.ts`. Проверить и положить туда.
2. Создать `packages/core/src/repositories/task.repo.ts`:
   ```ts
   export class TaskRepository {
     constructor(private memory: MemoryDB) {}
     listTasks = (...) => this.memory.listTasks(...);
     insertTask = (...) => this.memory.insertTask(...);
     // ... все методы, которые route вызывает напрямую
     buildHistoryLoader(scope, sinceUnix) { return (limit, offset) => { ... }; }
   }
   ```
   Loader использует `listCompletedTasksSince` + новые `searchTaskDigests`/`countTaskDigestsSince`.
3. `packages/server/src/routes/tasks.ts`:
   - Заменить `tasksRoute(memory: MemoryDB)` → `tasksRoute(repo: TaskRepository)`.
   - Удалить `buildHistoryLoader` + `DigestRow` (уехали в repo).
   - Все `memory.X(...)` → `repo.X(...)`.
   - Целевой LOC ≤150.
4. `packages/server/src/app/deps.ts` или wherever `tasksRoute` создаётся — инжектировать `new TaskRepository(memory)` вместо raw memory.
5. Удалить `"packages/server/src/routes/tasks.ts"` из `TRANSITIONAL_SQL_ROUTES` Set + `TRANSITIONAL_WHITELIST` row.

## Тесты

- `tests/layer-boundary.test.ts` — green (no SQL pattern in routes).
- `tests/repo-rules.test.ts` no-SQL-in-routes — без whitelist для tasks.
- `bun test tests/tasks*` — все green.

## Приёмка

Из repo root, exit 0:

1. `bun run scripts/check-file-size.ts` — `routes/tasks.ts` ≤150, transitional entry удалена.
2. `bun run scripts/check-deep-imports.ts` — без regression.
3. `bunx tsc --noEmit` — clean.
4. `bun test tests/repo-rules.test.ts` — 5/5 (tasks SQL whitelist row removed).
5. `bun test` — без новых failed (baseline 838/0).
6. `grep -nE "SELECT|INSERT INTO|UPDATE.*SET|DELETE FROM" packages/server/src/routes/tasks.ts` → пусто.
7. `wc -l packages/server/src/routes/tasks.ts` ≤150.

## Constraints

- Scope-lock: только файлы в §Файлы.
- Не трогать TaskScope/TaskStatus enum в `db/types.ts`.
- Public HTTP API identical: route shapes (request/response/status codes) не меняются.
- `paginate()` envelope сохраняется.
