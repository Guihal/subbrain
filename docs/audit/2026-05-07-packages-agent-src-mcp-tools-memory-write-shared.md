# packages/agent/src/mcp/tools/memory/write-shared.ts

## File
- Path: packages/agent/src/mcp/tools/memory/write-shared.ts
- Last modified: 2026-05-05T13:34:08+03:00
- Lines: 253

## Metrics
- Cyclomatic: 31
- Maintainability Index: 35.14 (with comments) / 23.32 (without)
- Halstead difficulty: 6.58
- Coupling instability: 0 (no afferent/efferent data)
- Test:code ratio: n/a
- Functions: 5 named + 4 anonymous (top complex: insertAndSupersede@7, writeShared@6, writeWithDedupAsync@6, doInsert@5, maybeReject@2)

## Smells
- [fat-function] `insertAndSupersede` 79 LOC, cyclomatic 7 — dual-path insert (svc vs rag) with nested try/catch/rollback @119
- [fat-function] `doInsert` 39 LOC, cyclomatic 5 — near-identical embed+txn logic duplicated from `insertAndSupersede` @207
- [deep-nesting] 4-level nesting in `insertAndSupersede`: try→try→try→catch (rollback catch inside link-failure catch inside insert catch) @128
- [dead-branch] `if (!rag) return {code:"no_insert_path"}` @171 unreachable — `rag` is truthy in this branch (guarded by caller at :88 and :97)
- [magic-string] `"warn"` / `"reject"` env toggle in `mode()` — no const enum @36
- [magic-string] `"validation_failed"`, `"insert_failed"`, `"supersede_link_failed"`, `"embed_failed"`, `"embed_empty"`, `"txn_failed"`, `"no_insert_path"` scattered, no shared error-code enum @44,142,164,178,185,201,171
- [single-arg-logger] `log.warn("supersede_link_failed", { meta: ... })` — 2-arg ok, but `log.warn(`would_reject: ${reason}`, { meta: ctx })` at :45 uses template string in stage position; contract is `(stage, message, extra?)` @45
- [code-duplication] Embed-then-txn block appears twice: `insertAndSupersede` :173-203 and `doInsert` :231-250 — only difference is `updateShared(supersedesId)` call
- [code-duplication] Svc-insert try/catch block appears twice: `insertAndSupersede` :130-145 and `doInsert` :216-228 — identical shape
- [inconsistent-error-shape] `doInsert` returns `error: e instanceof Error ? e.message : String(e)` (string) @227 while `writeShared`/`insertAndSupersede` return `{code, message}` objects — consumer may need to handle both shapes
- [no-AbortSignal] `embedWithTimeout(rag, params.content)` lacks external signal threading; no way to cancel mid-embed on client disconnect @90,175,233
- [no-Promise.allSettled] Not applicable here (sequential flow), but `checkDuplicate` call is a single async await — if `checkDuplicate` internally fans out, that is its concern
- [missing-return-type] `writeShared` return type `ToolResult | Promise<ToolResult>` forces every caller to await/resolve — should be `Promise<ToolResult>` uniformly @49
- [undefined-param] `insertShared` call passes `undefined` as 4th positional arg (`source`) @72,189,240 — magic positional parameter

## Refactor proposal
- Split:
  - `packages/agent/src/mcp/tools/memory/write-shared/insert.ts` — `doInsert` + shared embed-txn helper
  - `packages/agent/src/mcp/tools/memory/write-shared/supersede.ts` — `insertAndSupersede` + rollback logic
  - `packages/agent/src/mcp/tools/memory/write-shared/validators.ts` — `mode()`, `maybeReject()`, env toggle + error-code enum
  - `packages/agent/src/mcp/tools/memory/write-shared/index.ts` — `writeShared` facade + `SharedWriteParams`/`SharedWriteDeps` (≤100 LOC orchestrator)
- Extract:
  - `embedThenInsertTxn(deps, params, kind, expiresAt, vec?)` — pure embed+insert+upsertEmbedding in txn, shared by `doInsert` and `insertAndSupersede`
  - `insertViaService(svc, params, kind, expiresAt)` — shared svc.insertShared wrapper with uniform `{code, message}` error shape
  - `rollbackOrphan(deps, newId)` — shared rollback helper for supersede failure
  - `buildError(code, err)` — uniform `ToolResult` error builder replacing 8 inline error objects
- Replace:
  - `typeof params.expires_at === "number" ? params.expires_at : defaultExpiresAt(...)` → extract `resolveExpiresAt(layer, category, raw)` pure function
  - `typeof result === "object"` guard @107,115 — narrow to `ToolResult` type guard `isToolError(result)`
  - `!rag` dead branch @171 — delete or assert unreachable
- Safety:
  - Thread `AbortSignal` through `embedWithTimeout(rag, content, signal?)` — compose with external signal in caller
  - Ensure `checkDuplicate` uses `Promise.allSettled` if it fans out to embed+search internally
  - Add `deps.memory.inTransaction()` guard or assert that `transaction()` calls are not nested

## Risk
- Level: medium
- Reason: `insertAndSupersede` has manual rollback logic on partial failure — split without preserving exact txn boundary semantics risks orphan rows or lost supersede links
- Test coverage observed: `tests/memory-write-enforcement.test.ts`, `tests/shared-embed-write.test.ts`, `tests/pipeline-post-dedupe.test.ts`, `tests/memory-service-link-related.test.ts`, `tests/memory-confidence-insert.test.ts`, `tests/memory-kind.test.ts`, `tests/post-link-related-contradictions.test.ts`, `tests/post-link-related-evolution.test.ts`
