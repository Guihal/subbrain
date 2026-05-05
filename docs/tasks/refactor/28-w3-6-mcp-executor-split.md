# 28-W3-6 — split `mcp/executor.ts` (361 → split-folder)

**Status:** OPEN. Master: [28-file-size-150-limit.md](28-file-size-150-limit.md) Wave 3.

**Order:** parallel. Зависит от W2-3 (memory-tools split — уже DONE).

## Цель

Разбить `packages/agent/src/mcp/executor/index.ts` (361 LOC) на split-folder. Public API = `ToolExecutor` class.

## Файлы

**Удалить**:
- `packages/agent/src/mcp/executor/index.ts`

**Создать**:
- `packages/agent/src/mcp/executor/index.ts` — `ToolExecutor` orchestrator class (≤120 LOC). State (memory, registry, dynamicTools, codeTools) + thin делегации.
- `packages/agent/src/mcp/executor/dispatch.ts` — `dispatch(name, args, ctx)` — priority array of resolvers (registry → dynamic → code-tools).
- `packages/agent/src/mcp/executor/context.ts` — `buildExecCtx({...})` builder + AgentContext discriminated union helpers (если есть).
- `packages/agent/src/mcp/executor/wiring.ts` — `setMemoryService`, `setRouter`, `setRoom`, `setDynamicTools`, `setCodeTools` setters (config phase).

**Trigger**: `scripts/check-file-size.ts` `"packages/agent/src/mcp/executor/index.ts": 362` → удалить.

## Изменение

1. `ToolExecutor` в `index.ts` — конструктор `(memory, registry, ...)` + публичные методы как тонкие диспатчеры.
2. Submodules — pure functions taking `{state, ctx}` deps explicitly.
3. Никаких изменений семантики.
4. Consumers (mcp/transport.ts, mcp/mcp-protocol.ts, agent-loop tool-runner) — через `~/mcp/executor` или `~/mcp` barrel.

## Тесты

- `bun test tests/mcp-tools.test.ts` — green.
- `bun test tests/agent-loop*.test.ts` — green.
- `bun test` — без regression (838/0).

## Приёмка

1. `bun run scripts/check-file-size.ts` — split ≤150, transitional удалена.
2. `bun run scripts/check-deep-imports.ts` — green.
3. `bunx tsc --noEmit` — clean.
4. `bun test tests/repo-rules.test.ts` — 5/5.
5. `bun test` — 838/0 baseline.

## Constraints

- Scope-lock: только файлы в §Файлы.
- Public API: `ToolExecutor` class methods + setters unchanged.
- Tool dispatcher = priority array of resolvers (registry → dynamic → code-tools).
- Не трогать `mcp/registry/*` или `mcp/tools/*` (это другие PRs).
