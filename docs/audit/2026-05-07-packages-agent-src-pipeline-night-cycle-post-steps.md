# packages/agent/src/pipeline/night-cycle/post-steps.ts

## File
- Path: packages/agent/src/pipeline/night-cycle/post-steps.ts
- Last modified: 2026-05-05T13:34:08+03:00
- Lines: 262

## Metrics
- Cyclomatic: 32
- Maintainability Index: 55.89 (with comments), 28.73 (without comments)
- Halstead difficulty: 0.73
- Coupling instability: 0 (afferent=0, efferent=0)
- Test:code ratio: n/a (no unit tests directly targeting post-steps.ts)
- Functions: 16 (top complex: runPostBatchSteps@17, runStep@1, 14 anonymous arrow callbacks@1 each)

## Smells
- [fat-function] `runPostBatchSteps` is 203 LOC (31 CLOC + 156 LLOC), cyclomatic 17 — orchestrates 14 sequential steps inline with no delegation @line:34
- [sequential-bottleneck] All 14 steps are `await runStep(...)` in strict serial order — no parallelism even for independent I/O-heavy steps (pruneShared/pruneContext/pruneFocus are independent; memory-dedup + decay-salience are read-heavy and could fan out) @line:46-244
- [magic-string] 14 distinct `banner` strings (e.g. "Resolve contradictions", "Prune shared_memory") duplicated as `errKey` (e.g. "Resolve", "Prune shared") — two-string-per-step convention with no enum or const map @line:46-48, 55-57, etc.
- [deep-nesting] `runStep` callback closures capture `result` and `deps` — 14 levels of nested async arrow functions inside the main function body, each 2-10 LOC
- [dead-branch-guard] `if (memoryService)` gates cross-layer-dedup and reflect steps; but `memoryService` is typed optional and the guard is correct. Not a smell per se, but the optional param in `NightCycle` ctor (3-arg legacy) means these steps are silently skipped in ~half the test surface @line:173, 196
- [logger-single-arg] `log.info(`${banner}...`)` at :253 — two-arg call, OK. But `log.info("shared pruned=...")` at :60, :70, :80 — single-arg, puts text into `stage`, `message` undefined. Same pattern at :98, :113, :123, :133, :147, :162, :185, :207, :227, :242 — 12 instances of single-arg `log.info` call @line:60, 70, 80, 98, 113, 123, 133, 147, 162, 185, 207, 227, 242
- [missing-allSettled] No `Promise.allSettled` — all 14 steps are strictly sequential `await`. Independent prune steps (shared/context/focus) and read-only steps (dedup, decay) could safely parallelize. The guardrail rule #2 (Promise.allSettled for fan-out) is violated @line:46-244
- [missing-abort-signal] No `AbortSignal` threading through any step call. `runStep` has no timeout or cancellation — a hung `resolveContradictions` or `runReflect` can stall the entire night cycle indefinitely @line:247-261
- [any-cast] `err as Error` in `runStep` @line:257 — `unknown` would be safer; `Error` is a reasonable cast but still a cast
- [legacy-oversize] File is 262 LOC, exceeding the 150-line cap by 112 lines. Pre-existing oversize per whitelist (`docs/tasks/refactor/28-file-size-150-limit.md`) — but this file is NOT on the whitelist, meaning it should have been split already
- [comment-drift] Header comment says "contradictions + prune* + stray-task migration" but actual steps include focus-rewrite, stale-task prune, memory-dedup, decay-salience, cross-layer-dedup, reflect, embed-log, janitor — 11 categories, comment covers 3 @line:2-4

## Refactor proposal
- Split:
  - `packages/agent/src/pipeline/night-cycle/post-steps/prune-phase.ts` — pruneShared, pruneContext, pruneFocus, pruneStaleTasks, pruneCompletedTasks (5 steps, independent I/O)
  - `packages/agent/src/pipeline/night-cycle/post-steps/dedup-phase.ts` — runMemoryDedup, decaySalience, runCrossLayerDedup (3 steps, read-heavy, can parallelize)
  - `packages/agent/src/pipeline/night-cycle/post-steps/reflect-phase.ts` — runFocusRewrite, runReflect, collectStrayTasks (3 steps, LLM-heavy)
  - `packages/agent/src/pipeline/night-cycle/post-steps/janitor-phase.ts` — runEmbedLog, runJanitor (2 steps, heavy IO/embed, lowest priority)
  - `packages/agent/src/pipeline/night-cycle/post-steps/index.ts` — orchestrator ≤100 lines, imports phases, runs them in order with `Promise.allSettled` where safe
- Extract:
  - `runPhase(name, steps[], result)` — generic phase runner that calls `Promise.allSettled` on independent steps, collects errors into `result.errors`
  - `StepConfig = { banner: string; errKey: string; fn: () => Promise<void>; parallel?: boolean }` — declarative step array instead of 14 inline calls
  - Move `runStep` helper to `packages/agent/src/pipeline/night-cycle/post-steps/run-step.ts`
- Replace:
  - `err as Error` → `err instanceof Error ? err.message : String(err)` @line:257
  - Single-arg `log.info` → `log.info("night.post", "shared pruned=...")` throughout
- Safety:
  - Add `AbortSignal` param to `runPostBatchSteps(deps, result, signal?)`, compose with `AbortSignal.timeout(N)` in caller (`index.ts`)
  - Thread `signal` through each step's `router.chat()` calls (already supported by ModelRouter)
  - Wrap independent prune steps in `Promise.allSettled` within a phase
  - Add per-phase timeout: `Promise.race([phasePromise, AbortSignal.timeout(PHASE_TIMEOUT_MS)])`

## Risk
- Level: medium
- Reason: Night cycle runs unattended at 03:00 UTC; any regression in step ordering (dedup before reflect, decay after dedup) or error handling (single failure must not abort cycle) corrupts memory layers or drops data silently
- Test coverage observed: `tests/night-cycle.test.ts` (script-style, no direct post-steps assertions), `tests/night-cycle-memory-dedup.test.ts`, `tests/night-cycle-reflect.test.ts`, `tests/night-cycle-cross-layer-dedup.test.ts`, `tests/night-cycle-embed-log.test.ts`, `tests/night-cycle-focus-rewrite.test.ts`, `tests/night-cycle-memory-janitor.test.ts`, `tests/tasks-stale-prune.test.ts`, `tests/memory-salience.test.ts` — no unit test directly imports `post-steps.ts` or asserts `runPostBatchSteps` behavior
