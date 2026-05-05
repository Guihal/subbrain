# 28-W2-1 — `routes/logs.ts` SQL → `LogRepository` методы

**Status:** OPEN. Master: [28-file-size-150-limit.md](28-file-size-150-limit.md) Wave 2.

## Цель

Убрать raw SQL из `packages/server/src/routes/logs.ts` (3 запроса в `/v1/logs/stats`). Перенести в `packages/core/src/repositories/log.repo.ts` как методы. Закрыть SoC violation: routes — view layer, не работает с DB напрямую.

## Файлы

**Изменить**:
- `packages/server/src/routes/logs.ts` (143 → ~120 LOC) — `/v1/logs/stats` хэндлер вызывает `repo.statsByRole()`, `repo.countDistinctSessions()`, `repo.countDistinctRequests()`. Никаких `memory.db.query(...)`.
- `packages/core/src/repositories/log.repo.ts` (74 → ~110 LOC) — добавить 3 метода + `LogStatsRow` тип в re-exports, либо domain типы в `packages/core/src/db/types.ts`.
- `packages/core/src/db/tables/log.ts` — добавить queries (`statsByRole`, `countDistinctSessions`, `countDistinctRequests`) + private prepared statements в class. Возвращают raw row arrays / scalar.
- `tests/repo-rules.test.ts` `TRANSITIONAL_SQL_ROUTES` Set — удалить `"packages/server/src/routes/logs.ts"` (если есть). 

**Не трогать**: `packages/agent/src/services/*`, `packages/core/src/db/index.ts` facade.

## Изменение

1. `packages/core/src/db/tables/log.ts` — добавить 3 метода в LogTable class:
   - `statsByRole(): LogStatsRow[]` — возвращает array `{role, count, total_tokens, first_at, last_at}`.
   - `countDistinctSessions(): number`.
   - `countDistinctRequests(): number` (фильтр `request_id != 'system'`).
   - Использовать `db.query(...).all()` / `.get()` через prepared statements внутри class (это data layer — там SQL легитимен).
2. `packages/core/src/repositories/log.repo.ts` — пробросить 3 метода:
   - `statsByRole = (): LogStatsRow[] => this.logs.statsByRole();`
   - `countDistinctSessions = (): number => this.logs.countDistinctSessions();`
   - `countDistinctRequests = (): number => this.logs.countDistinctRequests();`
   - Экспортировать `LogStatsRow` тип из `db/types.ts` или локально.
3. `packages/server/src/routes/logs.ts` — заменить 3 SQL вызова на repo вызовы. Сохранить response shape `{total_sessions, total_requests, by_role}` идентичным.
4. Repo создаётся в `app/deps.ts` — repository уже инжектируется в route, проверить что `logsRoute(repo)` принимает LogRepository, либо рефакторить под текущую сигнатуру (зависит от того, как route сегодня получает `memory`).
5. Удалить `"packages/server/src/routes/logs.ts"` из `TRANSITIONAL_SQL_ROUTES` Set в `tests/repo-rules.test.ts`.

## Тесты

- `bun test tests/layer-boundary.test.ts` — должен пройти (route не должен grep'аться по SQL pattern).
- `bun test tests/repo-rules.test.ts` no-SQL-in-routes тест — green.
- `curl http://localhost:4000/v1/logs/stats` — response shape без изменений (manual, опционально; baseline тестов достаточно).

## Приёмка

Из repo root, exit 0:

1. `bun run scripts/check-file-size.ts` — без regression.
2. `bun run scripts/check-deep-imports.ts` — без regression.
3. `bunx tsc --noEmit` — clean.
4. `bun test tests/repo-rules.test.ts` — все 5 зелёные (no-SQL-in-routes теперь действительно зелёный без whitelist).
5. `bun test` — без новых failed (baseline 838/0).
6. `grep -nE "SELECT|INSERT INTO|UPDATE.*SET|DELETE FROM" packages/server/src/routes/logs.ts` → пусто.

## Constraints

- Scope-lock: только файлы в §Файлы.
- Никакой бизнес-логики в repo (1:1 проброс из table class).
- Сохранить response shape `/v1/logs/stats` = `{total_sessions: number, total_requests: number, by_role: LogStatsRow[]}`.
