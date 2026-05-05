# 28-W3-7 — split `mcp/playwright-client.ts` (314 → split-folder)

**Status:** OPEN. Master: [28-file-size-150-limit.md](28-file-size-150-limit.md) Wave 3.

**Order:** parallel.

## Цель

Разбить `packages/agent/src/mcp/playwright/index.ts` (314 LOC) на split-folder. Public API = `PlaywrightClient` class (`callTool(name, args)` остаётся главной точкой входа).

## Файлы

**Удалить**:
- `packages/agent/src/mcp/playwright/index.ts`

**Создать**:
- `packages/agent/src/mcp/playwright/index.ts` — `PlaywrightClient` class (≤120 LOC). Lifecycle (browser singleton + scoped contexts) + публичный `callTool(name, args)` диспатч.
- `packages/agent/src/mcp/playwright/lifecycle.ts` — `launchBrowser`, `getScopePage`, `close`. Browser channel `chrome` headless + `--no-sandbox`.
- `packages/agent/src/mcp/playwright/actions/click.ts` — click handler (resolves `data-pw-ref`).
- `packages/agent/src/mcp/playwright/actions/type.ts` — type/fill handler.
- `packages/agent/src/mcp/playwright/actions/navigate.ts` — navigate + back/forward.
- `packages/agent/src/mcp/playwright/actions/snapshot.ts` — accessibility snapshot tagger (assigns `data-pw-ref="N"`).
- `packages/agent/src/mcp/playwright/actions/evaluate.ts` — evaluate / run_code helpers.

**Trigger**: `scripts/check-file-size.ts` `"packages/agent/src/mcp/playwright/index.ts": 315` → удалить.

## Изменение

1. `PlaywrightClient` class в `index.ts` хранит browser/contexts state + `callTool` switch routes по name → soothing module.
2. Action modules — pure async functions taking `page` + args.
3. Lifecycle module — initialization + teardown (singleton browser).
4. **CRITICAL**: scoped contexts (`getScopePage("freelance")` etc) — incognito + UA override — preserved.
5. Consumers (`scheduler/freelance/*`, `mcp/tools/web-tools`, `free-agent`) — через `~/mcp/playwright` или `~/mcp` barrel.

## Тесты

- `bun test tests/playwright*.test.ts` — green (если есть).
- `bun test` — без regression (838/0).

## Приёмка

1. `bun run scripts/check-file-size.ts` — split ≤150, transitional удалена.
2. `bun run scripts/check-deep-imports.ts` — green.
3. `bunx tsc --noEmit` — clean.
4. `bun test tests/repo-rules.test.ts` — 5/5.
5. `bun test` — 838/0 baseline.

## Constraints

- Scope-lock: только файлы в §Файлы.
- Public API: `PlaywrightClient.callTool(name, args)` + `getScopePage` + `close` unchanged.
- Browser channel `chrome` (Dockerfile installs it). Headless + `--no-sandbox`.
- `data-pw-ref` snapshot tagging preserved.
- Не редактировать consumers (scheduler/freelance/*) — только обновить import paths при необходимости.
