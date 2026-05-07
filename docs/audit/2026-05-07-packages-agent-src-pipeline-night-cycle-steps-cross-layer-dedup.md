# packages/agent/src/pipeline/night-cycle/steps/cross-layer-dedup.ts

## File
- Path: packages/agent/src/pipeline/night-cycle/steps/cross-layer-dedup.ts
- Last modified: 2026-05-05T13:34:08+03:00
- Lines: 245

## Metrics
- Cyclomatic: 38
- Maintainability Index: 47.43 (with comments), 23.25 (without comments)
- Halstead difficulty: 7.37
- Coupling instability: 0 (afferent=0, efferent=0)
- Test:code ratio: 338 lines test / 245 lines src = 1.38:1
- Functions: 6 named (top complex: dedupPair@12, promoteArchiveToShared@6, runCrossLayerDedup@4, cosineSimilarity@3, mostRecent@2, isPromoteDup@5, readEnv@1)

## Smells
- [fat-function] `dedupPair` 44 LOC, cyclomatic 12 — nested double loop (O(n*m)) with inline edge insertion, superseded_by branching, error swallowing @105
- [fat-function] `promoteArchiveToShared` 38 LOC, cyclomatic 6 — sequential candidate loop with inline dup check + service call + edge write @165
- [deep-nesting] `dedupPair` has 4 levels: for(ai) -> for(bi) -> if(cat) -> if(cos) -> try/catch @116-145
- [magic-number] `0.92` hardcoded as `DUP_COSINE_MIN` @29 (ok, named constant) but `1.0` weight literal repeated 3× @135, @195 without named constant
- [any-cast] `(err as Error).message` @143, @200 — `err` typed `unknown` in catch; should use `err instanceof Error ? err.message : String(err)`
- [logger-single-arg] `log.info("disabled (CROSS_LAYER_DEDUP_ENABLED=false)")` @216 — single-arg call puts text into `stage`, leaves `message` undefined per logger contract
- [logger-single-arg] `log.warn("supersede edge failed", { meta: { msg: ... } })` @143 — `meta` wrapper unnecessary; logger contract is `(stage, message, extra?)`
- [logger-single-arg] `log.warn("promote failed", { meta: { ... } })` @199 — same meta wrapper anti-pattern
- [logger-single-arg] `log.warn("pair failed", { meta: { msg: String(s.reason) } })` @234 — same
- [logger-single-arg] `log.info(\`done: pairs=...\`)` @240 — single-arg call, stage becomes the whole string
- [dead-branch] `if (inserted)` @137 — `linkEdge` returns `boolean` but never documented what `false` means; branch adds cognitive load without clarity
- [missing-transaction] `memoryService.insertShared` @187-194 followed by `memory.linkEdge` @195 — not wrapped in `db.transaction()`; partial failure = orphan shared row without edge
- [n-plus-one] `isPromoteDup` calls `memory.getShared(n.id)` inside loop @159 — one query per neighbour (max 5, bounded but still N+1 pattern)
- [type-assertion] `memory.getShared(n.id) as SharedRow | null` @159 — `getShared` already returns `SharedRow | null`; cast is redundant
- [inconsistent-naming] `arc.title` used as `category` @188 but `cat` field from aggregation is `lower(title)`; naming mismatch between archive title and shared category
- [env-parse-duplication] `readEnv` repeats `Number.parseInt` + `Number.isFinite` + range clamp pattern 3× @52-61 — extractable to `parseEnvInt`/`parseEnvFloat` helper

## Refactor proposal
- Split:
  - `packages/agent/src/pipeline/night-cycle/steps/cross-layer-dedup/cosine.ts` — `cosineSimilarity` (pure, reusable)
  - `packages/agent/src/pipeline/night-cycle/steps/cross-layer-dedup/config.ts` — `readEnv`, `Cfg`, `parseEnvInt`/`parseEnvFloat` helpers
  - `packages/agent/src/pipeline/night-cycle/steps/cross-layer-dedup/dedup-pair.ts` — `dedupPair` + `Item`, `PairStat`, `mostRecent`
  - `packages/agent/src/pipeline/night-cycle/steps/cross-layer-dedup/promote.ts` — `promoteArchiveToShared` + `isPromoteDup`
  - `packages/agent/src/pipeline/night-cycle/steps/cross-layer-dedup/index.ts` — `runCrossLayerDedup` orchestrator (≤100 lines)
- Extract:
  - `parseEnvInt(key, fallback, min, max)` and `parseEnvFloat(key, fallback, min, max)` → `config.ts`
  - `insertSupersedeEdge(memory, stale, live)` → `dedup-pair.ts` (wraps `linkEdge` + `setSupersededBy`, returns boolean)
  - `WEIGHT_SUPERSEDES = 1.0`, `WEIGHT_DERIVES = 1.0` → named constants in `config.ts`
  - `safeMessage(err: unknown): string` → shared util (replace both `(err as Error).message` casts)
- Replace:
  - `(err as Error).message` → `err instanceof Error ? err.message : String(err)` @143, @200
  - `memory.getShared(n.id) as SharedRow | null` → `memory.getShared(n.id)` @159 (remove redundant cast)
- Safety:
  - Wrap `memoryService.insertShared` + `memory.linkEdge` in `memory.transaction()` @187-195 to ensure atomic promote
  - Batch `getShared` lookups in `isPromoteDup` via `memory.getSharedMany(neighbours.map(n => n.id))` instead of N+1 loop (if `getSharedMany` available; otherwise document bound)
  - Fix all 5 logger calls to 2-arg form: `log.info("night.cross-layer", "disabled")`, `log.warn("night.cross-layer", "supersede edge failed", { msg })`, etc.

## Risk
- Level: medium
- Reason: Night cycle step with DB mutations (edge inserts, shared inserts, superseded_by updates); partial transaction failure could orphan rows or create inconsistent graph state. No rollback on promote failure.
- Test coverage observed: tests/night-cycle-cross-layer-dedup.test.ts (10 tests, all via `runCrossLayerDedup` public API — no direct unit tests for `dedupPair`, `isPromoteDup`, `promoteArchiveToShared` internals), tests/routes-memory-edges.test.ts (edge route tests, indirect)
