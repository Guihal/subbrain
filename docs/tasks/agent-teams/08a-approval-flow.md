# Agent-teams task 08a — Phase 8a Approval flow (destructive op gate)

**Status:** packetized contract
**Worker model:** Kimi K2.6 (8a-1 escalates to strong model — `schema` tier)
**Risk:** mixed — see per-packet `risk_tier`
**Spec:** `docs/specs/subbrain-main.md` § Risk Register HIGH (line 640), § Anti-scope (line 630), § NEW contracts (line 737), § Wave 4 (line 751)

**Hard dependencies (must be merged before 8a-3 starts):**

- Phase 1 (Bifrost) merged.
- **A2-3** (`tool.execute.before` hook wired into `tool-runner.ts`) merged.
- **A2-4** (`permission.ask` hook in pre-handler stage) merged.
- **A2-5** (5-variant `ToolResult` union with `toLegacy()` shim) merged.

> **PATH NOTE (2026-05-05):** A2 is not yet merged; `packages/agent/` does not exist. All `packages/agent/*` paths in this doc are **aspirational** — they resolve to `packages/agent/packages/agent/src/pipeline/agent-loop/*` in the current codebase. Kimi MUST create files under `packages/agent/packages/agent/src/pipeline/agent-loop/` (not `packages/agent/`) until A2 merges. The hook dispatcher lives at `packages/agent/packages/agent/packages/agent/packages/agent/src/pipeline/agent-loop/tool-runner.ts` today; 8a-3 registers its gate there.

8a is implemented as a **plugin on top of A2's hooks pipeline**, not as a parallel ad-hoc gate inside the tool runner. The approval check is a `tool.execute.before` hook registered after the existing auto-deny plugins (`tg-gates`, `code-tool-guards`, `scheduled-blacklist`) so auto-deny still fires first. 8a-1 / 8a-2 are independent of A2 and may merge in parallel.

Independent of Phase 5 observability — `metrics_log` table already exists (`packages/core/packages/core/src/db/schema.ts:218`).

## Scope

Phase 8a turns the declarative anti-scope bullet — *"Do not let autonomous
agents send money, email, SMS, Telegram replies, or destructive ops without an
explicit approval flow"* — into a real synchronous gate inside the agent-loop
hooks pipeline. The first cut adds a single approval surface: **Telegram inline-button
prompt to the operator chat**. Web UI, CLI, and multi-operator approval are
deferred.

The gate is **async-resume**: the tool call that hits the gate returns
`ToolResult` with `success: false` and `error.code: "awaiting_approval"`
immediately. The agent loop treats this like any other rejection. Resume
happens on the **next agent invocation** (next interactive message, next
scheduled tick, next free-agent wake-up) — there is no in-process wake-up,
no setTimeout, no polling. When the operator presses Approve, the
`approvals` row is updated; the next time the agent calls the same
`(tool_name, args_hash)` within the lookup window, the gate finds the
`approved` row and returns `success: true` (handler proceeds).

> **ToolResult shape (current codebase):** `{success: boolean, data?: unknown, error?: {code, message} | string}` (see `packages/agent/packages/agent/packages/agent/src/mcp/types.ts`). The doc uses `error.code` notation — this means `error` is the structured `{code, message}` form. If A2-5 (5-variant `kind` union) merges before 8a, the shape may change; 8a code must adapt to whichever shape is live at merge time.

Existing partial protections — `code-tool-validators.ts` (rejects hardcoded
facts), `telegram-spam-gate.ts` (focus-key block), `auth.service.ts` token
check — are **auto-deny gates** and stay in place. Hook ordering inside
the dispatcher is **strict and documented**:

```
[auto-deny hooks: tg-gates, code-tool-guards, scheduled-blacklist]   ← run FIRST
        │  (if any returns {success:false}, short-circuit)
        ▼
[approval hook: approval-gate]                                       ← runs SECOND
        │  (gated → returns {success:false, error:{code:'awaiting_approval'}}; reuses approved/denied)
        ▼
[handler]                                                            ← runs LAST
```

This ordering is enforced by the registration order in
`packages/agent/packages/agent/src/pipeline/agent-loop/plugins-internal.ts` (A2-9 already pins
`[code-tool-guards, tg-gates, scheduled-blacklist, freelance-scout]`;
8a-3 inserts the approval plugin **after** those four).

## Non-goals (apply to every packet below)

- No Web UI in this phase. `/v1/approvals` HTTP route is allowed (read-only) but no Vue/Nuxt page.
- No CLI prompt surface — `process.stdout` interactive prompts are out of scope.
- No multi-operator approval. Exactly one operator chat resolved at boot.
- No replacement of existing auto-deny gates (`code-tool-validators.ts`, `telegram-spam-gate.ts`, `auth.service.ts`).
- **No bypass for `agentMode==="interactive"`.** Interactive runs hit the same
  gate. The Risk Register entry is "no general approval flow" — uniformity
  is the point. A future packet may add a UX shortcut (e.g. inline-button in
  the chat itself) but the gate fires the same way today.
- No synchronous block of the agent loop — gate is async-resume only.
- No new approval surfaces beyond Telegram inline-button (no Slack, email, web push).
- No retroactive approval of past tool calls — only future calls gate.
- No admin override that auto-approves all calls. A boolean kill-switch (`APPROVAL_DISABLE=true`) is allowed but defaults off.
- No re-implementation of A2 hooks. 8a-3 must register through the hook dispatcher (`packages/agent/packages/agent/packages/agent/packages/agent/src/pipeline/agent-loop/tool-runner.ts` today, `packages/agent/hooks/dispatcher.ts` after A2); if A2-3/A2-4/A2-5 are not merged, 8a-3 fails fast with `FAIL: dependency_missing: A2-3/A2-4/A2-5`.

## Packet ordering

```
8a-1 (schema, strong-model)  ──▶  8a-2 (approval registry + operator resolver)
                                      │
                                      ▼
                                  8a-3 (approval-gate hook plugin)         ◀── needs A2-3/4/5
                                      │
                                      ▼
                                  8a-4 (TG inline-button surface)
                                      │
                                      ▼
                                  8a-5 (expiry sweep + retry-on-next-invocation contract)
                                      │
                                      ▼
                                  8a-6 (audit log + metrics)
                                      │
                                      ▼
                                  8a-7 (tests)
```

8a-2..8a-4 are sequential because 8a-3 imports the registry from 8a-2 and 8a-4
imports the bot wiring after the executor hook lands. 8a-5 needs 8a-3 in
place. 8a-6 + 8a-7 wait on the rest. Operator-resolution is **merged into 8a-2**
(not deferred to 8a-4) so 8a-3 can short-circuit with `approval_unavailable`
when no operator is set, without creating unresumable rows.

## Glossary (shared)

- **operator chat** — single Telegram chat that receives approval prompts. Resolved at boot in 8a-2 via `resolveOperatorChat()` as `Number(process.env.APPROVAL_OPERATOR_CHAT_ID ?? process.env.TG_OWNER_CHAT_ID)`. If both unset or `Number(...)` is `NaN` → `resolveOperatorChat()` returns `null` and gated tools auto-deny with `{success: false, error: {code: "approval_unavailable", message: "..."}}`. No DB row written in that case.
- **gated tool** — entry in the approval registry (8a-2) keyed by `(tool_name, agentMode)`. **Initial set: `tg_send_message` and `tg_send_report`, gated in BOTH `scheduled` AND `interactive` modes.** Both tools call `executor.tgSendMessage` (telegram.tools.ts:111; lib/telegram-report.ts:47,69,75) — gating only one leaves a bypass via `tg_send_report`. `code_*` execution stays out of scope until A2-network-deny lands.
- **agentMode** — value from `PublicToolContext.agentMode` (`"interactive" | "scheduled" | undefined`). Existing field, see `packages/agent/packages/agent/packages/agent/src/mcp/registry/tool-registry.ts`. Both modes are gated for tools in the seed list.
- **approval row** — row in `approvals` table (8a-1). Keyed by autoincrement `id`; lookup index on `(tool_name, args_hash, decided_at)`.
- **args_hash** — SHA-256 hex of the canonical-JSON-stringified `args` object. Used so subsequent retries with identical args find the same approval.
- **decision** — one of `"approved" | "denied" | "expired"`. Default expiry `APPROVAL_TTL_SEC=900` (15 min).
- **async resume** — agent gets `ToolResult{success: false, error: {code: "awaiting_approval", message: "..."}}` and the loop terminates normally (max-steps or done). The next agent invocation (new chat message, next scheduled tick, next free-agent loop) re-issues the same tool call; if approved within TTL, the gate returns `success: true` from a `reuse_approved` lookup.
- **ToolResult** — current shape: `{success: boolean, data?: unknown, error?: {code: string, message: string} | string}` (`packages/agent/packages/agent/packages/agent/src/mcp/types.ts`). 8a constructs structured errors as `{success: false, error: {code, message}}`. If A2-5 (5-variant `kind` union) merges before 8a, adapt to the new shape at merge time — do not pre-implement the unmerged union.
- **metrics_log** — existing table (`packages/core/packages/core/src/db/schema.ts:218`); 8a-6 reuses it (no new table) for approval audit entries with `snapshot.kind="approval_decision"`.

---

## 8a-1 — Approvals table + domain types (SCHEMA escalation)

> **STRONG-MODEL ONLY.** Schema migration for a security-tier feature.
> Kimi MUST return `FAIL: requires_strong_model` immediately and not edit
> any file. Strong-model human reviews migration, runs once on dev DB, then
> Kimi may pick up 8a-2.

```json
{
  "task_id": "8a-1",
  "goal": "Add approvals table to packages/core/packages/core/src/db/schema.ts and export Approval domain types from packages/core/src/db/tables/approvals.ts.",
  "non_goals": [
    "No backfill of historical tool calls into approvals.",
    "No FTS5 / sqlite-vec on approvals — plain B-tree indexes only.",
    "No write-side helpers in this packet (insert/update live in 8a-3 + 8a-4).",
    "No coupling to metrics_log schema — that is 8a-6.",
    "No change to existing tables; this packet is additive only."
  ],
  "allowed_write_paths": [
    "packages/core/packages/core/src/db/schema.ts",
    "packages/core/src/db/tables/approvals.ts"
  ],
  "read_context": [
    "packages/core/packages/core/src/db/schema.ts:215-225",
    "packages/core/packages/core/src/db/tables/freelance-leads.ts",
    "packages/core/packages/core/src/db/tables/code-tools.ts",
    "packages/core/packages/core/src/db/index.ts"
  ],
  "guardrails": "Invoke subbrain-guardrails skill before editing src/ files. Schema migration must be additive only; no ALTER of existing tables.",
  "risk_tier": "schema",
  "acceptance": [
    "bunx tsc --noEmit",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-deep-imports.ts",
    "bun test tests/db-schema.test.ts",
    "rg -n 'CREATE TABLE IF NOT EXISTS approvals' packages/core/packages/core/src/db/schema.ts",
    "rg -n 'export interface Approval' packages/core/src/db/tables/approvals.ts"
  ],
  "diff_budget_loc": 180,
  "file_count_max": 3,
  "rollback": "Drop approvals table on dev DB and revert schema.ts/tables/approvals.ts/index.ts to HEAD; no data migration needed since table is new.",
  "escalation_triggers": [
    "Spec contradicts existing migration pattern in packages/core/packages/core/src/db/schema.ts.",
    "Test DB at data/test.db has prior approvals table from earlier draft — investigate before re-creating.",
    "tsc fails with circular import between db/index.ts and tables/approvals.ts."
  ],
  "glossary": {
    "approvals": "New SQLite table: id INTEGER PK AUTOINCREMENT, tool_name TEXT NOT NULL, args_json TEXT NOT NULL, args_hash TEXT NOT NULL, requested_at INTEGER NOT NULL, decided_at INTEGER, decision TEXT CHECK(decision IN ('approved','denied','expired')), decided_by TEXT, expires_at INTEGER NOT NULL, agent_mode TEXT, request_id TEXT.",
    "indexes": "idx_approvals_lookup ON approvals(tool_name, args_hash, decided_at DESC); idx_approvals_pending ON approvals(decided_at) WHERE decided_at IS NULL.",
    "Approval": "TS interface mirroring the row shape; exported from packages/core/src/db/tables/approvals.ts.",
    "migration": "Migration 20 — next free after 19 (agent_tasks + pool tables, P2-1). Must consult wave-plan Migration ownership table before assigning."
  }
}
```

---

## 8a-2 — Approval registry + operator resolver

```json
{
  "task_id": "8a-2",
  "goal": "Add packages/agent/src/mcp/registry/approval-registry.ts exposing requiresApproval(toolName, agentMode), the gated-tool seed list with BOTH tg_send_message and tg_send_report in BOTH agentMode values, canonicalizeArgs() helper, and resolveOperatorChat() reading APPROVAL_OPERATOR_CHAT_ID with TG_OWNER_CHAT_ID fallback.",
  "non_goals": [
    "No DB writes in this packet — pure config + lookup functions.",
    "No coupling to ToolExecutor or any hooks dispatcher — registry is data + pure functions.",
    "No code_* gating — A2-network-deny lands separately; only tg_send_message and tg_send_report in initial set.",
    "No bypass for interactive mode — both gated tools require approval in BOTH 'interactive' and 'scheduled' modes.",
    "No reading of grammy / Telegram bot tokens here — operator resolver returns numeric chat id or null only."
  ],
  "allowed_write_paths": [
    "packages/agent/src/mcp/registry/approval-registry.ts",
    "tests/approval-registry.test.ts"
  ],
  "read_context": [
    "packages/agent/packages/agent/src/mcp/registry/telegram-spam-gate.ts",
    "packages/agent/packages/agent/src/mcp/registry/tool-registry.ts:30-90",
    "packages/agent/packages/agent/src/mcp/registry/telegram.tools.ts:93-118",
    "packages/agent/packages/agent/src/mcp/registry/report.tools.ts:45-62",
    "packages/agent/packages/agent/src/mcp/tools/telegram-report.ts:41-76",
    "docs/specs/subbrain-main.md:625-645"
  ],
  "guardrails": "Invoke subbrain-guardrails skill before editing src/ files. File cap 150 lines; if approval-registry.ts exceeds 150, split into approval-registry.ts + approval-registry/seed.ts.",
  "risk_tier": "security",
  "acceptance": [
    "bunx tsc --noEmit",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-deep-imports.ts",
    "bun test tests/approval-registry.test.ts",
    "rg -n 'export function requiresApproval' packages/agent/src/mcp/registry/approval-registry.ts",
    "rg -n 'export function resolveOperatorChat' packages/agent/src/mcp/registry/approval-registry.ts",
    "rg -n 'export function canonicalizeArgs' packages/agent/src/mcp/registry/approval-registry.ts",
    "rg -n \"tool: 'tg_send_message'\" packages/agent/src/mcp/registry/approval-registry.ts",
    "rg -n \"tool: 'tg_send_report'\" packages/agent/src/mcp/registry/approval-registry.ts"
  ],
  "diff_budget_loc": 160,
  "file_count_max": 2,
  "rollback": "Delete packages/agent/src/mcp/registry/approval-registry.ts + test file; nothing imports it yet so deletion is safe.",
  "escalation_triggers": [
    "Reviewer asks to add code_* tools — defer; out of scope for this packet.",
    "Reviewer asks to make the list dynamic / DB-backed — defer; static export only.",
    "agentMode type is not exported from tool-registry.ts — fix import path, do not redefine.",
    "Audit of packages/agent/src/mcp/registry/*.ts surfaces a third tool that calls executor.tgSendMessage — escalate; gated set must cover all such tools."
  ],
  "glossary": {
    "GATED_TOOLS": "Readonly array of { tool: string; modes: AgentMode[] }. Initial entries (exact): { tool: 'tg_send_message', modes: ['scheduled', 'interactive'] }, { tool: 'tg_send_report', modes: ['scheduled', 'interactive'] }.",
    "requiresApproval": "(toolName: string, agentMode: AgentMode | undefined) => boolean. Treats undefined agentMode as 'interactive'. Returns true iff (toolName, normalizedMode) appears in GATED_TOOLS.",
    "canonicalizeArgs": "(args: unknown) => string — JSON.stringify with sorted keys, used by 8a-3 for args_hash.",
    "resolveOperatorChat": "() => number | null. Reads process.env.APPROVAL_OPERATOR_CHAT_ID, falls back to process.env.TG_OWNER_CHAT_ID, returns Number() result or null when both unset / NaN.",
    "APPROVAL_DISABLE": "Env kill-switch. If process.env.APPROVAL_DISABLE === 'true', requiresApproval() returns false for all tools (gate bypassed). Default off."
  }
}
```

---

## 8a-3 — Approval-gate hook plugin (registers AFTER auto-deny plugins)

```json
{
  "task_id": "8a-3",
  "goal": "Add packages/agent/packages/agent/src/pipeline/agent-loop/approval-gate/index.ts as a Plugin that registers a tool.execute.before hook checking requiresApproval, calling resolveOperatorChat for availability, and either short-circuiting with {success:false, error:{code:'awaiting_approval'|'approval_unavailable'|'approval_denied'|'approval_expired'}} or allowing through to the handler when a fresh approved row exists; append the plugin to INTERNAL_PLUGINS in packages/agent/packages/agent/src/pipeline/agent-loop/plugins-internal.ts AFTER tg-gates, code-tool-guards, scheduled-blacklist so auto-deny still fires first.",
  "non_goals": [
    "No Telegram side-effects in this packet — operator notification lives in 8a-4 (a separate hook on the same approvals row insert).",
    "No retry / resume logic inside the hook — async-resume is implicit (next agent invocation re-runs the tool, hits the same args_hash, and finds the approved row).",
    "No modification of A2 hook order semantics — registration order is the only ordering primitive used.",
    "No change to existing auto-deny plugins — they keep their current short-circuit behavior.",
    "No bypass for code-tool sandbox handlers — sandbox path stays unchanged.",
    "Use current ToolResult shape {success, error?: {code,message}|string} from packages/agent/packages/agent/src/mcp/types.ts. If A2-5 (5-variant kind union) merges before 8a, adapt at merge time — do not pre-implement unmerged shapes."
  ],
  "allowed_write_paths": [
    "packages/agent/packages/agent/src/pipeline/agent-loop/approval-gate/index.ts",
    "packages/agent/packages/agent/src/pipeline/agent-loop/approval-gate/lookup.ts",
    "packages/agent/packages/agent/src/pipeline/agent-loop/plugins-internal.ts",
    "packages/core/src/db/tables/approvals.ts",
    "tests/plugin-approval-gate.test.ts"
  ],
  "read_context": [
    "packages/agent/packages/agent/packages/agent/src/pipeline/agent-loop/tool-runner.ts:95-200",
    "packages/agent/packages/agent/packages/agent/src/pipeline/agent-loop/tool-dispatch.ts",
    "packages/agent/src/mcp/registry/approval-registry.ts",
    "packages/agent/packages/agent/src/mcp/types.ts",
    "packages/core/src/db/tables/approvals.ts"
  ],
  "guardrails": "Invoke subbrain-guardrails skill before editing src/ files. File cap 150 lines per module; approval-gate/index.ts ≤150, lookup.ts ≤150. Orchestrator (plugins-internal.ts) ≤100 lines.",
  "risk_tier": "security",
  "acceptance": [
    "bunx tsc --noEmit",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-deep-imports.ts",
    "bun test tests/plugin-approval-gate.test.ts",
    "bun test tests/agent-loop-hooks.test.ts",
    "rg -n 'awaiting_approval' packages/agent/packages/agent/src/pipeline/agent-loop/approval-gate/index.ts",
    "rg -n 'approval_unavailable' packages/agent/packages/agent/src/pipeline/agent-loop/approval-gate/index.ts",
    "rg -n 'requiresApproval' packages/agent/packages/agent/src/pipeline/agent-loop/approval-gate/index.ts",
    "rg -n 'success: false' packages/agent/packages/agent/src/pipeline/agent-loop/approval-gate/index.ts",
    "rg -n 'approval-gate' packages/agent/packages/agent/src/pipeline/agent-loop/plugins-internal.ts",
    "node -e 'const s=require(\"fs\").readFileSync(\"packages/agent/packages/agent/src/pipeline/agent-loop/plugins-internal.ts\",\"utf8\"); const order=[\"code-tool-guards\",\"tg-gates\",\"scheduled-blacklist\",\"freelance-scout\",\"approval-gate\"]; let last=-1; for (const n of order){const i=s.indexOf(n); if(i<=last){console.error(\"order broken at\",n);process.exit(1);} last=i;}'"
  ],
  "diff_budget_loc": 280,
  "file_count_max": 5,
  "rollback": "Revert packages/agent/packages/agent/src/pipeline/agent-loop/plugins-internal.ts + delete approval-gate plugin dir + revert approvals.ts helpers; auto-deny plugins keep working unchanged.",
  "escalation_triggers": [
    "A2-3 / A2-4 / A2-5 not merged (no hook point in tool-runner.ts) — return FAIL: dependency_missing immediately, do not write any file.",
    "Existing test in tests/tool-runner.test.ts asserts unconditional dispatch — update test to seed agentMode='interactive' on a non-gated tool rather than weakening the gate.",
    "A2-3 / A2-4 / A2-5 not merged AND no interim hook point in tool-runner.ts — return FAIL: dependency_missing immediately, do not write any file. The current tool-runner.ts (packages/agent/packages/agent/packages/agent/src/pipeline/agent-loop/tool-runner.ts) has no before-hook dispatcher; 8a-3 MUST have a hook point.",
    "Concurrent inserts produce duplicate pending rows for the same args_hash within 1s — switch to INSERT OR IGNORE keyed on (tool_name, args_hash) WHERE decided_at IS NULL via a unique partial index, escalate if SQLite rejects the partial unique syntax.",
    "Plugin registration index in plugins-internal.ts ends up BEFORE any auto-deny plugin — STOP and re-order; ordering is a security invariant, not a hint.",
    "resolveOperatorChat() returns null and the gate still attempts to insert a pending row — this is a bug; the unavailable path must short-circuit BEFORE the DB write."
  ],
  "glossary": {
    "approval-gate plugin": "Plugin that registers a before-hook in tool-runner.ts (or hooks/dispatcher.ts after A2). The before-hook returns a ToolResult to short-circuit, or undefined passthrough sentinel to allow.",
    "lookup.ts": "Pure module exporting findFreshDecision({db, toolName, argsHash, ttlSec}): {status:'pending'|'approved'|'denied'|'expired'|'none', row?: Approval}. Reads latest approvals row for args_hash within APPROVAL_TTL_SEC.",
    "args_hash": "SHA-256 hex of canonicalizeArgs(args) (8a-2 glossary).",
    "lookup_window_sec": "APPROVAL_TTL_SEC env (default 900). Approvals older than this are ignored — agent must request fresh approval.",
    "passthrough_contract": "When findFreshDecision returns 'approved', the hook returns undefined so the dispatcher proceeds to the handler. When 'pending'/'denied'/'expired' it returns {success:false, error:{code:'awaiting_approval'|'approval_denied'|'approval_expired', message:'...'}}. When 'none' it inserts a pending row, fires the operator-notify side-channel via ctx (8a-4 wires this), and returns {success:false, error:{code:'awaiting_approval', message:'...'}}.",
    "unavailable_short_circuit": "If resolveOperatorChat() returns null, return {success:false, error:{code:'approval_unavailable', message:'...'}} WITHOUT inserting a DB row — testable independently of 8a-4."
  }
}
```

---

## 8a-4 — Telegram inline-button surface

```json
{
  "task_id": "8a-4",
  "goal": "Send approval prompt with inline keyboard to operator chat when a pending approvals row is created by 8a-3, and update the row decision when the operator clicks Approve or Deny.",
  "non_goals": [
    "No timed reminder / nag if operator does not respond — expiry handled in 8a-5.",
    "No formatting of args beyond JSON pretty-print + 1KB truncation.",
    "No multi-operator broadcast — exactly one chat id resolved at boot via resolveOperatorChat (8a-2).",
    "No retry of message send — single grammy send attempt; failure logs + leaves pending row to expire.",
    "No web push / Slack / email surface.",
    "No reading of APPROVAL_OPERATOR_CHAT_ID directly — must use resolveOperatorChat from 8a-2."
  ],
  "allowed_write_paths": [
    "packages/agent/src/telegram/bot/approvals.ts",
    "packages/agent/packages/agent/src/telegram/bot/index.ts",
    "packages/server/packages/server/src/app/deps.ts",
    "tests/approval-bot.test.ts"
  ],
  "read_context": [
    "packages/agent/packages/agent/src/telegram/bot/index.ts",
    "packages/agent/packages/agent/src/telegram/bot/notify.ts",
    "packages/agent/packages/agent/src/telegram/bot/commands.ts",
    "packages/server/packages/server/src/app/deps.ts:338-367",
    "packages/core/src/db/tables/approvals.ts",
    "packages/agent/src/mcp/registry/approval-registry.ts",
    "packages/agent/packages/agent/src/pipeline/agent-loop/approval-gate/index.ts"
  ],
  "guardrails": "Invoke subbrain-guardrails skill before editing src/ files. File cap 150 lines; approvals.ts ≤150.",
  "risk_tier": "security",
  "acceptance": [
    "bunx tsc --noEmit",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-deep-imports.ts",
    "bun test tests/approval-bot.test.ts",
    "rg -n 'approve:|deny:' packages/agent/src/telegram/bot/approvals.ts",
    "rg -n 'resolveOperatorChat' packages/agent/src/telegram/bot/approvals.ts"
  ],
  "diff_budget_loc": 260,
  "file_count_max": 4,
  "rollback": "Remove approvals.ts module + revert wiring in bot/index.ts and app/deps.ts; pending rows stay in DB and expire via 8a-5 cron.",
  "escalation_triggers": [
    "grammy callback_query payload size exceeds 64 bytes — switch to id-only payload `approve:<approvalId>` rather than embedding tool_name.",
    "TG_BOT_TOKEN unset and APPROVAL_OPERATOR_CHAT_ID set — log warning and disable approval prompts, do not crash boot. (8a-3 still short-circuits with approval_unavailable when resolveOperatorChat returns null, but TG bot itself can be unavailable separately.)",
    "Operator chat resolution returns null mid-boot — disable feature with structured log; do not throw."
  ],
  "glossary": {
    "operator_chat_id": "Number returned by resolveOperatorChat() (8a-2). Must NOT be re-derived from env here — single source of truth.",
    "callback_data": "Format `approve:<approvalId>` and `deny:<approvalId>`. Numeric id only — handler reads tool_name + args from DB.",
    "decided_by": "Telegram user id from callback_query.from.id (string), written to approvals.decided_by.",
    "decision_write": "On Approve → UPDATE approvals SET decision='approved', decided_at=unixepoch(), decided_by=? WHERE id=? AND decided_at IS NULL. On Deny → same with decision='denied'. WHERE decided_at IS NULL guards against double-clicks racing the sweeper."
  }
}
```

---

## 8a-5 — Expiry sweep + retry-on-next-invocation contract

```json
{
  "task_id": "8a-5",
  "goal": "Add periodic sweeper that marks pending approvals past expires_at as decision='expired'; document the retry-on-next-invocation contract — the agent loop does NOT wake up on approval, instead the next regular invocation (next chat message, next scheduled tick, next free-agent loop) re-runs the tool call and the gate finds the fresh decision.",
  "non_goals": [
    "No agent-loop wake-up mechanism — the loop terminates normally after {success:false, error:{code:'awaiting_approval'}}; resume is implicit on the next invocation.",
    "No setTimeout per row — single periodic sweep on a scheduler tick.",
    "No reopening of expired rows — operator must trigger a fresh request on the next agent invocation.",
    "No change to approval-gate hook lookup logic from 8a-3 — sweep is a separate code path.",
    "No exposure of sweep counter through observability in this packet (8a-6 handles audit).",
    "No 'wake-up' wording in code comments or logs — the contract is retry-on-next-invocation."
  ],
  "allowed_write_paths": [
    "packages/agent/src/scheduler/approval-sweeper.ts",
    "packages/server/packages/server/src/app/schedulers.ts",
    "tests/approval-sweeper.test.ts"
  ],
  "read_context": [
    "packages/agent/packages/agent/src/scheduler/free-agent.ts",
    "packages/server/packages/server/src/app/schedulers.ts",
    "packages/core/src/db/tables/approvals.ts",
    "packages/agent/packages/agent/src/pipeline/agent-loop/approval-gate/index.ts",
    "packages/agent/packages/agent/packages/agent/src/pipeline/agent-loop/run.ts:42-97"
  ],
  "guardrails": "Invoke subbrain-guardrails skill before editing src/ files. File cap 150 lines; approval-sweeper.ts ≤150.",
  "risk_tier": "public-api",
  "acceptance": [
    "bunx tsc --noEmit",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-deep-imports.ts",
    "bun test tests/approval-sweeper.test.ts",
    "rg -n 'expires_at < unixepoch' packages/agent/src/scheduler/approval-sweeper.ts",
    "rg -n 'installApprovalSweeper' packages/server/packages/server/src/app/schedulers.ts",
    "rg -n 'retry-on-next-invocation\\|next agent invocation' packages/agent/src/scheduler/approval-sweeper.ts"
  ],
  "diff_budget_loc": 160,
  "file_count_max": 3,
  "rollback": "Remove approval-sweeper.ts + revert schedulers.ts wiring; pending rows accumulate but agent-gate ignores stale rows past TTL.",
  "escalation_triggers": [
    "Existing scheduler bootstrap pattern uses different signature — match installFreelanceScoutScheduler exactly.",
    "Sweep deletes rows instead of UPDATE — escalate; audit log (8a-6) requires retained history.",
    "Sweep collides with 8a-4 callback handler updating a row mid-tick — wrap UPDATE in db.transaction() with WHERE decided_at IS NULL clause to make it idempotent.",
    "Reviewer asks for in-process wake-up of the agent loop — escalate; the contract is intentionally retry-on-next-invocation to keep the agent loop stateless and the approvals table the only durable state."
  ],
  "glossary": {
    "sweep_interval_ms": "APPROVAL_SWEEP_MS env (default 60_000).",
    "expiry_query": "UPDATE approvals SET decision='expired', decided_at=unixepoch() WHERE decided_at IS NULL AND expires_at < unixepoch().",
    "retry_on_next_invocation_contract": "After {success:false, error:{code:'awaiting_approval'}}, the loop returns to the caller (max-steps or done). The next time the same agent context runs (interactive: user sends another message; scheduled: next cron tick; free-agent: next FREE_AGENT_INTERVAL_MIN tick) and the agent calls the same tg_send_message/tg_send_report with identical args, the gate hashes args, finds the now-approved row inside lookup_window_sec, and lets the handler run."
  }
}
```

---

## 8a-6 — Audit log via metrics_log

```json
{
  "task_id": "8a-6",
  "goal": "Write a metrics_log row with snapshot.kind='approval_decision' for every approval state change (requested, approved, denied, expired).",
  "non_goals": [
    "No new approval_log table — reuse metrics_log only.",
    "No dashboard / observability UI — Phase 5 surface owns rendering.",
    "No PII redaction beyond what existing log helpers do — args already passed sanitizers in 8a-2 canonicalize.",
    "No rate-limiting of audit writes — every state change emits exactly one row.",
    "No async batching — synchronous insert inside the same db.transaction() as the approvals UPDATE."
  ],
  "allowed_write_paths": [
    "src/lib/approval-audit.ts",
    "packages/agent/packages/agent/src/pipeline/agent-loop/approval-gate/index.ts",
    "packages/agent/src/telegram/bot/approvals.ts",
    "packages/agent/src/scheduler/approval-sweeper.ts"
  ],
  "guardrails": "Invoke subbrain-guardrails skill before editing src/ files. File cap 150 lines; approval-audit.ts ≤150.",
  "read_context": [
    "packages/core/src/lib/metrics.ts:80-110",
    "packages/core/packages/core/src/db/schema.ts:218-225",
    "packages/core/src/db/tables/approvals.ts"
  ],
  "risk_tier": "public-api",
  "acceptance": [
    "bunx tsc --noEmit",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-deep-imports.ts",
    "bun test tests/approval-audit.test.ts",
    "rg -n 'approval_decision' src/lib/approval-audit.ts",
    "rg -n 'logApprovalDecision' packages/agent/packages/agent/src/pipeline/agent-loop/approval-gate/index.ts packages/agent/src/telegram/bot/approvals.ts packages/agent/src/scheduler/approval-sweeper.ts"
  ],
  "diff_budget_loc": 180,
  "file_count_max": 4,
  "rollback": "Remove approval-audit.ts and revert call sites; approvals table still holds final decision so no audit data lost in current row, only state-transition history disappears.",
  "escalation_triggers": [
    "metrics_log schema changes between draft and merge — defer to Phase 5 review.",
    "Snapshot JSON payload exceeds 4KB on a single event — truncate args_json to 1KB and add `truncated:true` flag, do not split into multiple rows.",
    "Existing metrics writer uses queue/batch — bypass it, write directly via repo helper to keep transactional with approvals UPDATE."
  ],
  "glossary": {
    "snapshot.kind": "Discriminator string. Existing values live in packages/core/src/lib/metrics.ts; this packet adds 'approval_decision'.",
    "snapshot fields": "{ kind:'approval_decision', approval_id:number, tool_name:string, agent_mode:string|null, transition:'requested'|'approved'|'denied'|'expired', decided_by:string|null, ts:number }.",
    "logApprovalDecision": "Helper that wraps the metrics_log INSERT and is called from approval-gate plugin (requested), bot/approvals.ts (approved/denied), approval-sweeper.ts (expired)."
  }
}
```

---

## 8a-7 — Tests

```json
{
  "task_id": "8a-7",
  "goal": "Add integration test covering golden approve flow on tg_send_message AND tg_send_report, denial flow, expiry flow, operator-unavailable fallback, and interactive-mode-also-gated invariant.",
  "non_goals": [
    "No live Telegram API calls — bot interactions stubbed via grammy test transformer or in-process mock.",
    "No concurrency stress test — single-thread bun:test only.",
    "No code coverage target enforcement.",
    "No replacement of existing tool-runner tests — additive only.",
    "No snapshot tests of message text — assert structural fields (callback_data, decision, ToolResult.kind, error.code).",
    "Use current ToolResult shape {success, error?} from packages/agent/packages/agent/src/mcp/types.ts in tests. If A2-5 merges before 8a, adapt test assertions to the new shape at merge time."
  ],
  "allowed_write_paths": [
    "tests/approval-flow.test.ts",
    "tests/fixtures/approval-flow/operator-stub.ts"
  ],
  "read_context": [
    "tests/tool-runner.test.ts",
    "tests/freelance-scout.test.ts",
    "packages/agent/packages/agent/src/pipeline/agent-loop/approval-gate/index.ts",
    "packages/agent/src/telegram/bot/approvals.ts",
    "packages/agent/src/scheduler/approval-sweeper.ts",
    "packages/agent/src/mcp/registry/approval-registry.ts"
  ],
  "guardrails": "Invoke subbrain-guardrails skill before editing src/ files. File cap 150 lines; approval-flow.test.ts ≤320 (test files exempt from 150 cap but should stay tight).",
  "risk_tier": "ordinary",
  "acceptance": [
    "bunx tsc --noEmit",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-deep-imports.ts",
    "bun test tests/approval-flow.test.ts",
    "rg -n \"describe\\\\('approval flow\" tests/approval-flow.test.ts",
    "rg -n 'operator unavailable|expired|denied|approved|interactive_also_gated' tests/approval-flow.test.ts",
    "rg -n 'tg_send_report' tests/approval-flow.test.ts"
  ],
  "diff_budget_loc": 320,
  "file_count_max": 2,
  "rollback": "Delete tests/approval-flow.test.ts + fixture; no production code touched.",
  "escalation_triggers": [
    "Test DB at data/test.db has stale approvals rows from prior runs — beforeEach must DELETE FROM approvals; if not isolated, escalate.",
    "Stubbing grammy bot requires undocumented internal — switch to direct call into packages/agent/src/telegram/bot/approvals.ts handler with synthetic callback payload.",
    "Expiry test depends on real wall-clock — inject ts via dependency injection on approval-sweeper helper, do not sleep.",
    "Interactive-mode-also-gated case fails because some path bypasses the gate — STOP, do not weaken the test; the bypass is the bug."
  ],
  "glossary": {
    "golden_case_send_message": "Agent calls tg_send_message in scheduled mode → pending row + ToolResult{success:false, error:{code:'awaiting_approval', message:'...'}}; operator approves via callback handler; second agent invocation within TTL re-runs the same tool call → ToolResult{success:true, data:...}.",
    "golden_case_send_report": "Same as above but tool_name='tg_send_report'; ensures both Telegram-egress tools are gated.",
    "denial_case": "Operator denies → second invocation returns ToolResult{success:false, error:{code:'approval_denied', message:'...'}}.",
    "expiry_case": "Operator never responds; sweeper fires after expires_at → row decision='expired'; second invocation returns ToolResult{success:false, error:{code:'approval_expired', message:'...'}}.",
    "unavailable_case": "APPROVAL_OPERATOR_CHAT_ID unset + TG_OWNER_CHAT_ID unset → first agent call returns ToolResult{success:false, error:{code:'approval_unavailable', message:'...'}} immediately, no DB row written.",
    "interactive_also_gated": "Agent in interactive mode calls tg_send_message (or tg_send_report); gate must still fire (success:false, error.code:'awaiting_approval') because GATED_TOOLS lists both modes. This case proves the no-bypass invariant in the non-goals."
  }
}
```
