# web/app/composables/useMemory.ts

## File
- Path: web/app/composables/useMemory.ts
- Last modified: 2026-05-05T08:05:12+03:00
- Lines: 278

## Metrics
- Cyclomatic: 95
- Maintainability Index: 33.99
- Halstead difficulty: <not available from AST metrics>
- Coupling instability: <not available>
- Test:code ratio: 0 (no test files reference this composable)
- Functions: 9 inside `useMemory()` body (loadPending, refreshPendingCount, setPendingStatus, approveMemory, rejectMemory, fetchEdges, totalForActive, loadActive, switchTab, select) + 3 factory-returned closures (sharedL.load/save/remove, contextL.load/save/remove, archiveL.load/save/remove, agentL.load/save/remove, logL.load/save/remove) + 3 from useMemoryFocus (loadFocus, saveFocus, deleteFocus) + 3 from useMemoryLayer (load, save, remove) + 1 qs helper

## Smells
- [fat-function] `useMemory()` body spans 220 LOC (lines 59-278) with cyclomatic 48 — violates file-cap 150 and function-cap ~50 guidance @line:59
- [deep-nesting] No literal indentation nesting >4, but semantic nesting is extreme: 14 `useState` declarations + 5 `useMemoryLayer` calls + 1 `useMemoryFocus` call + 4 pending functions + 2 computed/loadActive dispatchers + return object with 40+ keys — all in one closure scope @line:59-278
- [magic-number] `page_size=100` hardcoded in `fetchEdges` URL @line:170; `limit=50` hardcoded in `refreshPendingCount` log-sessions fetch @line:113; `pageSize` default = 50 @line:65
- [empty-catch] `refreshPendingCount` silently swallows all errors: `} catch { /* silent: counter is decorative */ }` @line:149-151
- [any-cast] `(e as Error).message` in `loadPending` @line:136; same pattern in `useMemoryLayer.load` @line:42 and `useMemoryFocus.loadFocus` @line:23
- [any-cast] `(s as unknown as { id: T["id"] }).id` in `useMemoryLayer.save` @line:55 and `remove` @line:68 — `MemoryRow` discriminated union lacks a generic `id` field, forcing cast
- [any-cast] `(updated as object)` and `as MemoryRow` in `useMemoryLayer.save` @line:58-59
- [god-return] Return object has 40+ keys — every consumer gets full surface even when only a subset is needed @line:224-277
- [missing-abort] `api()` calls (wrapping `$fetch`) have no `AbortSignal` threading; long-running `loadPending` or `fetchEdges` cannot be cancelled @line:131, @line:167
- [promise-all-not-allsettled] `refreshPendingCount` uses `Promise.all` for two independent API calls; one failure kills both @line:144 — though the catch block swallows everything, so the failure is hidden
- [dead-branch] `totalForActive` switch has no `default` — if `activeTab` is an unexpected value, `computed` returns `undefined` implicitly @line:174-191
- [dead-branch] `loadActive` switch has no `default` — same issue @line:193-210
- [layer-leak] `useMemory.ts` exports `EdgeInfo` interface (M-14 feature) which is a data shape, not a composable concern — should live in `types.ts` or a domain file @line:52-57
- [layer-leak] `PendingRow`, `PendingLayer`, `ExtendedMemoryTab` types defined in composable instead of `types.ts` @line:46-50
- [cross-import-smell] `MemoryRow.vue` imports `useMemory` just to call `fetchEdges` — creates unnecessary coupling to the full composable surface @file:web/app/components/MemoryRow.vue:3,53
- [no-tests] Zero test coverage — no `*.test.ts` references `useMemory`, `useMemoryLayer`, `useMemoryFocus`, or `useMemoryPage`

## Refactor proposal
- Split:
  - `web/app/composables/useMemory/pending.ts` — move `PendingRow`, `PendingLayer`, `ExtendedMemoryTab`, `loadPending`, `refreshPendingCount`, `setPendingStatus`, `approveMemory`, `rejectMemory`
  - `web/app/composables/useMemory/edges.ts` — move `EdgeInfo` interface + `fetchEdges`
  - `web/app/composables/useMemory/index.ts` — thin orchestrator (≤100 lines): state declarations, deps wiring, `switchTab`, `loadActive`, `select`, return object
  - Keep `useMemory/layer.ts`, `useMemory/focus.ts`, `useMemory/types.ts` as-is (already split)
- Extract:
  - `buildStdQuery(page, pageSize, search)` → pure function in `useMemory/lib.ts` (replaces inline `stdQuery`)
  - `makeTabLoader(tab, layers)` → pure dispatcher mapping tab→loader, replaces `loadActive` switch
  - `makeTabTotal(tab, layers)` → pure dispatcher, replaces `totalForActive` switch
  - `safeCount(api)` → wraps `refreshPendingCount` with proper error typing
- Replace:
  - `(e as Error).message` → typed error helper `getErrorMessage(e: unknown): string`
  - `(s as unknown as { id: T["id"] }).id` → add `id` to `MemoryRow` base or use `ExtractId<T>` generic
  - `(updated as object)` → remove cast by making `api<T>` return shape match `MemoryRow` construction
  - `EdgeInfo` → move to `types.ts`
  - `PendingRow`, `PendingLayer`, `ExtendedMemoryTab` → move to `types.ts`
- Safety:
  - `refreshPendingCount`: change `Promise.all` → `Promise.allSettled` so one endpoint failure does not mask the other
  - Add optional `signal?: AbortSignal` to `api()` in `useApi.ts` (or accept `opts` passthrough) and thread through `load`, `loadPending`, `fetchEdges`
  - `loadPending`: add `signal` param and pass to `api()` for cancellable tab switches
  - Empty catch @line:149: at minimum log to console.warn; better — write to `error` state with a non-fatal flag

## Risk
- Level: medium
- Reason: `useMemory()` is the single source of state for `/memory` page; 9 Vue components import from it. A botched split breaks reactive wiring or state key collisions. No tests exist to catch regressions.
- Test coverage observed: none (no test files reference useMemory / useMemoryLayer / useMemoryFocus / useMemoryPage)
