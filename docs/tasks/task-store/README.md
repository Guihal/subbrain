# Task Store + prompt-injection + TG-reliability

План v6 разбит на 6 фаз. Phases 1-2 **готовы** (merged, tests green). Phases 3-6 — в этой папке, по одному файлу на фазу. Каждый файл self-contained — можно запускать в свежем чате `/task --depth=<X> <содержимое файла>`.

## Оригинальный план

`~/vault/RLM/Daily/2026-04-22.md` и `Daily/2026-04-23.md` — финальная v6-версия плана и журнал первых двух фаз. Критик прогнан depth=2, все 11 substantive gaps закрыты.

## Архитектура

Три стора без overlap:
- **`memory`** (shared/layer2/layer3) — immutable facts (кто юзер, паттерны, архитектура)
- **`tasks`** — mutable lifecycle state (open → in_progress → done/cancelled → prune)
- **`scheduler_state`** — ephemeral runtime flags (lock owner, last_check, heartbeats)

## Статус фаз

| # | Файл | Дни | Статус |
|---|------|-----|--------|
| 1 | (done) Task Store foundation | 1.5 | ✅ PR в `main` (daily 2026-04-22 23:50) |
| 2 | (done) Prompt injection + env retire | 0.5 | ✅ PR в `main` (daily 2026-04-23 00:04) |
| 3 | [03-hippocampus-rate-limit.md](03-hippocampus-rate-limit.md) | 0.2 | 🟡 pending |
| 4 | [04-tg-reliability.md](04-tg-reliability.md) | 1.0 | 🟡 pending |
| 5 | [05-retention-digest-migration.md](05-retention-digest-migration.md) | 0.75 | 🟡 pending |
| 6 | [06-web-ui-tasks.md](06-web-ui-tasks.md) | 1.0 | 🟡 pending |

**Порядок:** 3 → 4 → 5 → 6. Зависимости внутри файлов. Phase 4 требует Phase 3 опционально (hippocampus rate-limit защитит TG-burst); Phase 5 требует Phase 4 (retention digest работает с tasks которые TG-поллер пишет); Phase 6 можно параллельно после Phase 1 (UI читает из REST /v1/tasks который уже есть).

## Сделанное в Phases 1-2 (чего повторять не надо)

- `tasks` + `scheduler_state` таблицы (migration 6) в [packages/core/packages/core/src/db/schema.ts](../../../packages/core/packages/core/src/db/schema.ts).
- TasksTable с upsertBySource (3-query tx, idempotent на terminal) в [packages/core/packages/core/src/db/tables/tasks.ts](../../../packages/core/packages/core/src/db/tables/tasks.ts).
- SchedulerStateTable с `tryAcquireLock` (single-statement CAS через INSERT OR IGNORE + UPDATE...RETURNING) + `heartbeat` в [packages/core/packages/core/src/db/tables/scheduler-state.ts](../../../packages/core/packages/core/src/db/tables/scheduler-state.ts) — готов к использованию в Phase 4.
- MCP `task_add/list/update/start/done/cancel` (scope=agent-only) в [packages/agent/packages/agent/src/mcp/registry/tasks.tools.ts](../../../packages/agent/packages/agent/src/mcp/registry/tasks.tools.ts).
- Domain `TasksTools` в [packages/agent/packages/agent/src/mcp/tools/tasks-tools.ts](../../../packages/agent/packages/agent/src/mcp/tools/tasks-tools.ts).
- REST `/v1/tasks` + `/history` в [packages/server/packages/server/src/routes/tasks.ts](../../../packages/server/packages/server/src/routes/tasks.ts).
- Tool-runner: `task_*` timeout 3000ms в [packages/agent/packages/agent/packages/agent/src/pipeline/agent-loop/tool-runner.ts](../../../packages/agent/packages/agent/packages/agent/src/pipeline/agent-loop/tool-runner.ts).
- System-prompt injection (`renderActiveTasks`, `renderTgStatus`) в [packages/agent/packages/agent/packages/agent/src/pipeline/agent-loop/prompt-blocks/tasks.ts](../../../packages/agent/packages/agent/packages/agent/src/pipeline/agent-loop/prompt-blocks/tasks.ts) + подключено в [packages/agent/packages/agent/packages/agent/src/pipeline/agent-loop/system-prompt.ts](../../../packages/agent/packages/agent/packages/agent/src/pipeline/agent-loop/system-prompt.ts).
- `AUTONOMOUS_TASK` env fail-fast в [packages/server/packages/server/src/app/deps.ts](../../../packages/server/packages/server/src/app/deps.ts).
- 307 tests passing (275 Phase 1 + 32 Phase 2).

## Guardrails (для всех оставшихся фаз)

Перед edit в `src/`, `web/app/`, `scripts/`, `tests/` — skill `subbrain-guardrails`:

- File cap 250 lines, one responsibility.
- `Promise.allSettled` для fan-out. `AbortController` composed с external signal.
- Per-tool timeout в tool-runner.ts (`task_=3000` уже есть, не менять).
- SQLite: мутации в `db.transaction()`. FTS через `sanitizeFtsQuery`. Миграции per-statement `.run()`.
- HTTP: `fetchJson`/`fetchStream` из `packages/core/packages/core/src/lib/http-client.ts`.
- TypeBox для routes (t.Object / t.Union литералов).
- `logger.child("stage").info("msg")` — двухаргументный у root, одноаргументный у child.
- Tests `bun:test` без top-level `process.exit`; `*.live.ts` не подхватываются `bun test`.
- Deploy ручной (GitHub-auth blocked) — не предлагать `gh pr create`, `gh workflow run`.

## Verify gate (каждая фаза завершается тремя проверками)

```bash
bunx tsc --noEmit     # exit 0
bun test              # no regressions (total count растёт; 307 на конец Phase 2)
git status --short    # proof changes applied
```
