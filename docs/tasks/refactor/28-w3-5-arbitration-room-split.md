# 28-W3-5 — split `pipeline/arbitration-room.ts` (420 → split-folder)

**Status:** OPEN. Master: [28-file-size-150-limit.md](28-file-size-150-limit.md) Wave 3.

**Order:** parallel с другими W3-5..W3-10.

## Цель

Разбить `packages/agent/packages/agent/src/pipeline/arbitration/index.ts` (420 LOC) на split-folder. Public API = `ArbitrationRoom` class.

## Файлы

**Удалить**:
- `packages/agent/packages/agent/src/pipeline/arbitration/index.ts`

**Создать**:
- `packages/agent/packages/agent/packages/agent/src/pipeline/arbitration/index.ts` — `ArbitrationRoom` orchestrator (≤120 LOC). Public методы (`runRoom`, `consult`, и т.д.) — thin делегации.
- `packages/agent/packages/agent/packages/agent/src/pipeline/arbitration/prompts.ts` — system-prompt builders для specialists + teamlead synthesis prompt.
- `packages/agent/packages/agent/packages/agent/src/pipeline/arbitration/weights.ts` — weight resolution (по virtual roles из model-map).
- `packages/agent/packages/agent/packages/agent/src/pipeline/arbitration/dispatch.ts` — fan-out specialists через `Promise.allSettled` (НЕ `Promise.all`! guardrail). AbortSignal composition. Возвращает array of results.
- `packages/agent/packages/agent/packages/agent/src/pipeline/arbitration/synthesis.ts` — teamlead synthesis call + result aggregation.

**Trigger**: `scripts/check-file-size.ts` `"packages/agent/packages/agent/src/pipeline/arbitration/index.ts": 421` → удалить.

## Изменение

1. `ArbitrationRoom` class — конструктор `(router: ModelRouter)` + thin делегации.
2. Submodules — pure functions taking `{router, signal, logger}` deps + params.
3. **CRITICAL guardrail**: `Promise.allSettled` обязательно (НИКОГДА `Promise.all`) — фан-аут специалистов.
4. AbortController composition: внешний signal + per-call timeout через `AbortSignal.any([extSignal, AbortSignal.timeout(N)])`.
5. Consumers: `phases/room.ts` — через `~/pipeline/arbitration`.

## Тесты

- `bun test tests/arbitration*.test.ts` — green.
- `bun test` — без regression (838/0).

## Приёмка

1. `bun run scripts/check-file-size.ts` — split ≤150, transitional удалена.
2. `bun run scripts/check-deep-imports.ts` — green.
3. `bunx tsc --noEmit` — clean.
4. `bun test tests/repo-rules.test.ts` — 5/5.
5. `bun test` — 838/0 baseline.
6. `grep -nE 'Promise\.all\b' packages/agent/src/pipeline/arbitration/` → пусто (только `Promise.allSettled`).

## Constraints

- Scope-lock: только файлы в §Файлы.
- Public API: `ArbitrationRoom` class methods unchanged.
- `Promise.allSettled` mandatory (никогда `Promise.all`).
- Не редактируем `phases/room.ts` (только обновить import path при необходимости).
