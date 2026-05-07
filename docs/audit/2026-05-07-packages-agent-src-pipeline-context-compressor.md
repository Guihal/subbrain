# packages/agent/src/pipeline/context-compressor.ts

## File
- Path: packages/agent/src/pipeline/context-compressor.ts
- Last modified: 2026-05-05T13:34:08+03:00
- Lines: 282

## Metrics
- Cyclomatic: 27
- Maintainability Index: 53.38 (with comments), 21.78 (without comments)
- Halstead difficulty: 33.875
- Halstead effort: 100075.83
- Coupling instability: 0 (afferent=0, efferent=0 — self-contained module)
- Test:code ratio: ~0.43 (120 test LOC / 282 src LOC)
- Functions: 4 (top complex: compressContext@21, anonymous serialize mapper@4, shouldCompress@1, anonymous@1)

## Smells
- [fat-function] `compressContext` is 177 LOC with cyc=21, MI=46.57 — does head/tail split, orphan snapping, serialization, LLM call, JSON parse, fact normalization, fact persistence, in-place mutation, logging @line:100
- [deep-nesting] 4+ levels: try→if→try→if inside `compressContext` (LLM response handling @line:176-208)
- [magic-strings] `"(ничего значимого)"`, `"(nothing notable)"` hardcoded Russian + English no-op markers @line:211-214
- [magic-numbers] `64` (category slice), `500` (tool args slice), `2000` (tool content slice), `4096` (max_tokens), `0.2` (temperature) inline without named constants @line:161,166,184,185,242
- [any-cast] `as any` in test helper only (not in source), but source has `(f as { content?: unknown })` and `(err as Error)` @line:223,225,230,205,256
- [non-null-assertion] `m.tool_call_id ?? ""` — fallback is fine but `??` masks potential undefined; `tc.function.arguments.slice(0, 500)` assumes shape @line:166,161
- [missing-safety] `router.chat` call lacks `AbortSignal` threading — compressor has no cancellation path if the outer request is aborted @line:177
- [missing-safety] Fact persistence loop uses sequential `await` inside `for…of` — not fan-out, but if ever parallelized must use `Promise.allSettled` (currently sequential is correct for DB writes, but no batch API) @line:241-259
- [logger-single-arg] None found — all logger calls use 2+ args correctly
- [dead-branch] None found — all returns have clear paths
- [empty-block] `catch {}` at line 196 is intentional JSON parse fallback, acceptable
- [cross-layer?] `categoryToKind` import from `post/validators` — compressor (logic layer) reaching into post-phase validator; minor coupling
- [biome-ignore] `noConfusingVoidType` suppression at line 51 for `CompressorMemory` interface — indicates type shape tension between sync `MemoryDB` and async `MemoryService`

## Refactor proposal
- Split:
  - `packages/agent/src/pipeline/context-compressor/split.ts` — `findHeadEnd`, `findTailStart` (orphan snap logic), `extractMiddle`
  - `packages/agent/src/pipeline/context-compressor/serialize.ts` — `serializeMessagesToText(messages, maxChars)`
  - `packages/agent/src/pipeline/context-compressor/parse.ts` — `parseCompressorResponse(raw): { summary, facts }`
  - `packages/agent/src/pipeline/context-compressor/persist.ts` — `persistFacts(facts, memory): Promise<number>`
  - `packages/agent/src/pipeline/context-compressor/index.ts` — orchestrator ≤100 lines, re-exports `shouldCompress`, `compressContext`
- Extract:
  - `findHeadEnd(messages): number` from lines 115-119
  - `findTailStart(messages, headEnd, keepRecent): number` from lines 123-140
  - `serializeMiddle(middle, maxChars): string` from lines 157-171
  - `parseCompressorJson(raw): CompressorResult` from lines 176-208
  - `normalizeFacts(facts): NormalizedFact[]` from lines 220-234
  - `persistFacts(normalizedFacts, memory): Promise<number>` from lines 239-264
- Replace:
  - `(f as { content?: unknown })?.content` → `unknown` guard function `getField(obj: unknown, key: string): unknown`
  - `(err as Error).message` → `err instanceof Error ? err.message : String(err)`
  - `const resp = await router.chat(...)` → add optional `signal?: AbortSignal` to `compressContext` opts, thread through to `router.chat`
- Safety:
  - Thread `AbortSignal` from caller through `compressContext` → `router.chat`
  - Fact persistence is intentionally sequential (DB writes); no `Promise.allSettled` needed here
  - No raw fetch — already uses `router.chat` (correct)

## Risk
- Level: medium
- Reason: `compressContext` mutates `messages` in-place (line 272-273); any extraction must preserve the same mutation contract or callers (`agent-loop/run.ts`, `agent-loop/stream.ts`, `chat/persist.ts`, `night-cycle/steps/compress.ts`) will desync. The `CompressorMemory` interface is a union of sync `MemoryDB` and async `MemoryService` shapes — changing it requires updating all callers.
- Test coverage observed: tests/context-compressor.test.ts (5 tests: threshold, collapse+fact-write, failure no-op, below-limit no-op, constant sanity)
