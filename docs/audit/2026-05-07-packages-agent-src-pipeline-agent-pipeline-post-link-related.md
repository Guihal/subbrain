# packages/agent/src/pipeline/agent-pipeline/post/link-related.ts

## File
- Path: packages/agent/src/pipeline/agent-pipeline/post/link-related.ts
- Last modified: 2026-05-05T13:34:08+03:00
- Lines: 246

## Metrics
- Cyclomatic: 44
- Maintainability Index: 34.37 (with comments), 20.58 (without comments)
- Halstead difficulty: 11.89
- Coupling instability: 0 (afferent=0, efferent=0 — isolated module)
- Test:code ratio: 3 test files / 246 LOC (~1:82 per file, but total test LOC >> source LOC)
- Functions: 15 (top complex: linkRelated@14, detectContradictions@7, evolveNeighbour@5, parseTagsCsv@4, sameSet@3, mergeUnique@2)

## Smells
- [fat-function] `linkRelated` 82 LOC, cyc=14 — orchestrates RAG search, edge linking, tag evolution, contradiction detection in one flow @line:155
- [fat-function] `detectContradictions` 61 LOC, cyc=7 — LLM call + JSON extraction + validation + clamping all inline @line:88
- [deep-nesting] `linkRelated` has 5 levels: try→for→if→try→if→try (RAG loop → edge insert → layer check → evolve → catch) @line:169-212
- [magic-number] `LINK_RELATED_TOP_N = 3` exported but hardcoded; `MAX_TAGS_DEFAULT = 10`, `MIN_CONTRADICTION_CONF_DEFAULT = 0.7` @line:7-10
- [magic-string] `"relates"`, `"contradicts"` edge kinds as raw literals (no `EdgeKind` enum) @line:181,231
- [any-cast] `parsed as { contradicts?: unknown }` @line:142; `item as { id?: unknown }` @line:147; `item as { confidence?: unknown }` @line:148
- [dead-branch] `if (n.layer === "context" || n.layer === "shared")` in linkRelated line 183 is always true because `neighbours` is filtered to `[layer]` at RAG call; the check is redundant but harmless
- [missing-abort] `router.chat()` in `detectContradictions` not threaded with `AbortSignal` — long TTTF on cold `glm-5.1` (20-30s) has no escape hatch @line:106
- [missing-allsettled] Not applicable — no fan-out of upstream calls inside this file; single sequential RAG search then single LLM call
- [logger-contract] All log calls are 2-arg (`stage, message`) — OK per contract
- [empty-block] No empty blocks observed
- [non-null-assertion] None observed

## Refactor proposal
- Split:
  - `packages/agent/src/pipeline/agent-pipeline/post/link-related/evolve.ts` — `parseTagsCsv`, `mergeUnique`, `sameSet`, `evolveNeighbour`, env helpers `evolveEnabled`, `maxTags`
  - `packages/agent/src/pipeline/agent-pipeline/post/link-related/contradict.ts` — `detectContradictions`, `minConf`, `detectEnabled`, `contradictModel`, interfaces `ContradictionCandidate`, `ContradictionVerdict`
  - `packages/agent/src/pipeline/agent-pipeline/post/link-related/index.ts` — `linkRelated` orchestrator only (≤100 lines), imports from sibling modules
- Extract:
  - `buildContradictionPrompt(insertedContent, candidates): { sys, user }` → pure function, testable without router
  - `parseContradictionJson(raw): ContradictionVerdict[]` → pure JSON extraction + validation, replaces 4 `any` casts with `unknown` + `zod` or `t.Object` narrowing
  - `drawRelatesEdge(memory, insertedId, layer, neighbour, log): boolean` → extracted from RAG loop body to flatten nesting
- Replace:
  - `parsed as { contradicts?: unknown }` → `function isContradictionArray(v: unknown): v is Array<{id: string; confidence: number}>` with runtime type guard
  - `item as { id?: unknown }` / `item as { confidence?: unknown }` → same guard eliminates all 3 `any` casts
- Safety:
  - Add `AbortSignal` param to `linkRelated` signature, pass through to `router.chat()` in `detectContradictions` — compose with external signal + internal timeout (e.g. `AbortSignal.any([signal, AbortSignal.timeout(30_000)])`)
  - Consider `Promise.allSettled` if contradiction candidates ever grow >1 batch; currently sequential but LLM call is single-shot

## Risk
- Level: medium
- Reason: `linkRelated` is a post-write hook called from `extractors.ts` (writeShared/writeContext) AND `MemoryService.insertShared/insertContext` — 4 call sites. Break = silent edge loss or tag corruption on every memory write. Tests cover all 4 paths but are integration-style (real DB + fake RAG).
- Test coverage observed:
  - `tests/post-link-related-evolution.test.ts` — M-05.1 tag evolution (8 cases)
  - `tests/post-link-related-contradictions.test.ts` — M-05.2 contradiction detection (8 cases)
  - `tests/memory-service-link-related.test.ts` — M-13 MemoryService post-hook (5 cases)
