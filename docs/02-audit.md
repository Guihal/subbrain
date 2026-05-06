# Subbrain Code Audit Report

> Date: 2026-05-06
> Branch: a2-4-attempt3
> HEAD: eb278b7
> Auditors: type-safety-auditor, file-size-soc-auditor (subagents)

---

## Executive Summary

| Area | Status | Issues | Severity |
|---|---|---|---|
| Type safety (`any` / `as unknown`) | **10 violations** | 10 new-fix, 6 defensive-ok, 4 legacy, 3 generated | Medium-High |
| File-size compliance | **Clean** | 0 new violations, 25 legacy oversize, 4 whitelisted | Low |
| Three-layer SoC | **Clean** | 0 violations | — |
| Coupling / dependency graph | **Not audited** | 3rd subagent rejected by user | — |

---

## 1. Type-Safety Audit

### 1.1 Summary

| Category | Count | Severity |
|---|---|---|
| `generated` (BAML client) | 3 | Low — out of scope |
| `defensive-ok` (runtime guard, JSON.parse, grammy session, polyfill) | 6 | Low — acceptable |
| `legacy-acceptable` (old patterns, non-critical paths) | 4 | Medium — backlog |
| `new-violation` (should be fixed now) | **10** | High — fix in next PR |

### 1.2 New-Violation Details

| # | File:line | Reason | Recommended Fix |
|---|---|---|---|
| 1 | `packages/agent/src/mcp/registry/tool-registry.ts:143` | `def as unknown as ToolDef` — erases generics on register | Store as `ToolDef<never, never>` or use mapped store type |
| 2 | `packages/agent/src/mcp/registry/tool-registry.ts:206` | `tool.input as unknown as Record<string,unknown>` — TypeBox → JSON Schema cast is a lie | Add helper `typeboxToJsonSchema(schema)` with structural proof |
| 3 | `packages/agent/src/mcp/registry/tool-registry.ts:222` | Same as #2, in `toOpenAIToolsForAgent` | Same fix as #2 |
| 4 | `packages/agent/src/pipeline/agent-pipeline/types.ts:17` | `tools?: any[]` — central pipeline type leaks `any` | Define `OpenAITool[]` and replace |
| 5 | `packages/agent/src/pipeline/agent-pipeline/types.ts:18` | `tool_choice?: any` — same as #4 | Same fix as #4 |
| 6 | `packages/agent/src/scheduler/freelance/persist.ts:56` | `bot as unknown as BotInternal` — duck-type to private TelegramBot internals | Export minimal `TelegramBotNotify` interface, accept union type |
| 7 | `packages/agent/src/services/chat/run.ts:33` | `params.tools as unknown[] | undefined` — depends on #4/#5 | Once #4 fixed, use `OpenAITool[]` with validation |
| 8 | `packages/server/src/mcp-transport/transport.ts:17` | `({ body }: { body: any })` — Elysia route bypasses validation | Remove explicit type; let Elysia infer or use `unknown` + narrow |
| 9 | `web/app/composables/useChatSend.ts:80` | `catch (err: any)` — loses error type safety | `catch (err: unknown)` + instanceof narrowing |
| 10 | `web/app/composables/useMemory/layer.ts:55,68` | `(s as unknown as { id: T["id"] }).id` — bypasses discriminant | Narrow with `"id" in s` or add type guard |
| 11 | `web/app/pages/memory.vue:81,83` | `(row as any)` — `ApprovalRow` cast to `MemoryRow` hides real mismatch | Define mapper `toMemoryRow(row: ApprovalRow): MemoryRow` |

### 1.3 Defensive-OK (Keep As-Is)

| File:line | Reason |
|---|---|
| `packages/agent/src/lib/structured-output/arbitration.ts:28` | `Array.isArray` guard → `unknown[]` → `filter(string)` — correct narrow-before-filter |
| `packages/agent/src/lib/structured-output/hippocampus.ts:28` | Same pattern as above |
| `packages/agent/src/pipeline/agent-pipeline/post/parse-write.ts:22` | Same `Array.isArray` → `unknown[]` → `filter(string)` pattern |
| `packages/agent/src/scheduler/agent-pool/runners/free.ts:113` | `JSON.parse(v) as unknown` — recursive parser; `unknown` is correct signal |
| `packages/agent/src/telegram/userbot/index.ts:43,101` | grammy `session.save()` returns `Buffer \| string`; runtime is always string here |
| `packages/core/src/lib/http-client.ts:53` | `AbortSignal.any` polyfill; cast guarded by `typeof anyFn === "function"` |

### 1.4 Legacy-Acceptable (Backlog)

| File:line | Reason | Fix Effort |
|---|---|---|
| `packages/agent/src/pipeline/night-cycle/types.ts:98` | `parseJson(text: string): any` — convenience in old night-cycle code | Small: change to `unknown`, update ~5 call-sites |
| `packages/server/src/routes/freelance.ts:56` | `as unknown as Elysia` — known Elysia TS chain inference quirk | Small: split chain or add `@ts-expect-error` |
| `packages/server/src/routes/memory.ts:279` | Same Elysia quirk as above | Same fix |
| `packages/agent/src/baml_client/watchers.ts:34,78` | Generated BAML FFI bridge code | Out of scope; add to Biome ignore |

### 1.5 Priority Fixes (Top 5 by Impact)

| Rank | Fix | Files | Impact | Effort |
|---|---|---|---|---|
| 1 | Type `PipelineRequest.tools` / `tool_choice` | `types.ts:17-18`, `services/chat/run.ts:33` | High — central interface | Small (~10 lines) |
| 2 | Remove `body: any` in MCP transport | `transport.ts:17` | High — REST entry point for all tool calls | Tiny (~2 lines) |
| 3 | Fix `ApprovalRow` → `MemoryRow` mapping | `memory.vue:81-83` | Medium-High — UI render safety | Small (~15 lines) |
| 4 | Fix `useMemory/layer.ts` id access | `layer.ts:55,68` | Medium — composable used across admin | Tiny (~4 lines) |
| 5 | Replace `BotInternal` duck-type | `freelance/persist.ts:56` | Medium — brittle coupling to private internals | Small (~8 lines) |

---

## 2. File-Size + SoC Audit

### 2.1 File-Size Summary

**Ground truth:** `bun run scripts/check-file-size.ts` → **exit 0** (all within cap).

| Category | Count |
|---|---|
| **Whitelisted** (canonical) | 4 |
| **Legacy-oversize** (transitional, locked) | 25 |
| **New-violation** (>cap, not whitelisted) | **0** |

### 2.2 Oversize Files (Legacy / Whitelisted)

| File | Lines | Cap | Headroom | Notes |
|---|---|---|---|---|
| `packages/core/src/db/schema.ts` | 1043 | 1500 | 457 | Canonical whitelist |
| `packages/core/src/db/index.ts` | 485 | 500 | 15 | Canonical whitelist — monitor closely |
| `packages/core/src/db/types.ts` | 277 | 300 | 23 | Canonical whitelist |
| `packages/agent/src/pipeline/agent-loop/system-prompt.ts` | 291 | 300 | 9 | Canonical whitelist |
| `packages/server/src/app/deps.ts` | 368 | 400 | 32 | Legacy oversize (C2 target) |
| `packages/core/src/db/tables/tasks.ts` | 282 | 305 | 23 | Legacy oversize |
| `packages/server/src/routes/memory.ts` | 281 | 300 | 19 | Legacy oversize |
| `packages/agent/src/pipeline/context-compressor.ts` | 281 | 300 | 19 | Legacy oversize |
| `packages/agent/src/mcp/registry/agent-meta.tools.ts` | 280 | 290 | 10 | Legacy oversize |
| `web/app/composables/useMemory.ts` | 278 | 279 | **1** | Legacy oversize — urgent |
| `packages/agent/src/pipeline/agent-pipeline/post/extractors.ts` | 278 | 281 | **3** | Legacy oversize — urgent |
| `packages/agent/src/mcp/registry/tool-registry.ts` | 269 | 273 | **4** | Legacy oversize |
| `packages/agent/src/pipeline/night-cycle/post-steps.ts` | 261 | 262 | **1** | Legacy oversize — urgent |
| `packages/agent/src/mcp/tools/memory/write-shared.ts` | 252 | 253 | **1** | Legacy oversize — urgent |
| `packages/agent/src/pipeline/agent-loop/tool-runner.ts` | 247 | 250 | **3** | Legacy oversize |
| `packages/agent/src/pipeline/agent-pipeline/post/link-related.ts` | 245 | 246 | **1** | Legacy oversize — urgent |
| `packages/agent/src/pipeline/night-cycle/steps/cross-layer-dedup.ts` | 244 | 245 | **1** | Legacy oversize — urgent |
| `packages/agent/src/pipeline/agent-pipeline/pre/exec-summary.ts` | 230 | 245 | 15 | Legacy oversize |
| `packages/agent/src/pipeline/agent-pipeline/post/dedupe.ts` | 218 | 241 | 23 | Legacy oversize |
| `packages/agent/src/pipeline/agent-loop/shared.ts` | 210 | 224 | 14 | Legacy oversize |
| `packages/core/src/db/tables/log.ts` | 207 | 215 | 8 | Legacy oversize |
| `packages/core/src/lib/logger.ts` | 206 | 210 | 4 | Legacy oversize |
| `web/app/components/ChatSidebar.vue` | 198 | 202 | 4 | Legacy oversize |
| `packages/agent/src/mcp/registry/memory.tools.ts` | 198 | 250 | 52 | Glob whitelist — safe |
| `packages/agent/src/pipeline/agent-pipeline/phases/post.ts` | 197 | 200 | 3 | Legacy oversize |
| `packages/agent/src/mcp/tools/memory-curation-tools.ts` | 195 | 201 | 6 | Legacy oversize |
| `web/app/components/memory/MemoryList.vue` | 190 | 193 | 3 | Legacy oversize |
| `packages/agent/src/pipeline/night-cycle/steps/memory-dedup-utils.ts` | 189 | 202 | 13 | Legacy oversize |
| `packages/agent/src/scheduler/telegram-poller.ts` | 186 | 202 | 16 | Legacy oversize |

**Critical:** 6 files have ≤3 lines of headroom. Any emergency patch (logging, guard clause, type tweak) will breach cap and block CI.

### 2.3 Top 5 Split Candidates (by Imminent Breach Risk)

| Rank | File | Lines / Cap | Headroom | Why Urgent |
|---|---|---|---|---|
| 1 | `packages/agent/src/pipeline/night-cycle/post-steps.ts` | 261 / 262 | **1** | Night-cycle post-processing |
| 2 | `packages/agent/src/mcp/tools/memory/write-shared.ts` | 252 / 253 | **1** | Core memory write path |
| 3 | `packages/agent/src/pipeline/agent-pipeline/post/link-related.ts` | 245 / 246 | **1** | Post-phase link resolver |
| 4 | `packages/agent/src/pipeline/night-cycle/steps/cross-layer-dedup.ts` | 244 / 245 | **1** | Night-cycle deduplication |
| 5 | `web/app/composables/useMemory.ts` | 278 / 279 | **1** | Frontend memory admin composable |

### 2.4 Three-Layer SoC

**All checks pass. Zero violations.**

| Check | Result |
|---|---|
| Raw SQL in routes | **0 matches** — routes delegate to repositories |
| Raw fetch in pages/components | **0 matches** — all via composables |
| Data layer → logic/transport imports | **0 matches** — clean boundary |
| Routes importing raw SQL files | **0 matches** — routes import from `@subbrain/core/repositories/*` |
| Deep imports (≥3 segments) | **0 matches** — `check-deep-imports.ts` passes |

---

## 3. Coupling / Dependency Graph

> **Status: Not audited.** The 3rd subagent (`coupling-auditor`) was rejected by user during dispatch. Re-dispatch pending user direction.

Planned checks:
- Cross-package imports (server→agent, agent→server, web→packages)
- Circular dependencies (pipeline ↔ services, mcp ↔ pipeline)
- Deep imports beyond whitelist
- Mixed concerns (orchestration + business logic in single files)
- Unified pattern gaps (fetchJson consistency, updateRow usage, scheduler patterns)

---

## 4. Hourly Audit Log

### 2026-05-06 ~16:30 UTC
- Checked: Full codebase type-safety + file-size + SoC (3 subagents dispatched, 2 completed, 1 rejected)
- Findings: 10 type-safety violations (new-fix), 0 file-size violations, 0 SoC violations, 6 files at 1-line headroom
- Reverted to fail: none (all done packets remain valid)
- Clean: **Partial** — type-safety debt exists but no regressions

---

## 5. Recommended Next Actions

1. **Type safety (Wave 4 candidate):** Fix top 5 `new-violation` items. Effort: ~40 lines total. No functional change.
2. **File-size maintenance:** Split 6 files with 1-line headroom before next feature work. Prioritize hot paths (`write-shared.ts`, `post-steps.ts`).
3. **Coupling audit:** Re-dispatch coupling-auditor subagent to complete the picture.
4. **BAML generated code:** Add `packages/agent/src/baml_client/**` to Biome ignore list to stop noise.
