# A2 — Plugin runtime + hooks pipeline (internal plugins only)

Status: NOT STARTED. Source spec: `docs/specs/subbrain-main.md` § "Runtime
Architecture Track (Variant B)" → "A2 — Plugin runtime + hooks pipeline
(internal only)" (lines 579-597).

## Goal

Replace ad-hoc, scattered tool gates with a single hooks pipeline owned by
`packages/agent/`. Internal modules become `Plugin`-shaped registrations.
External behavior is unchanged: same gates fire on the same inputs and
produce the same `tool_result` payloads. Whether a check runs as inline
code (today) or as `tool.execute.before` hook (after A2) must be invisible
to the LLM, the REST surface, and the SQLite logs.

## Hard dependency

A1 — Bun workspaces split — must be merged first. A2 builds on the
`packages/plugin/` types-only package and the `packages/agent/` workspace
that A1 creates. If those packages do not exist, every A2 packet must
escalate before writing code (see `escalation_triggers`).

## Hook surface (5 hooks, frozen for A2)

| Hook                     | Phase                                  | Purpose                                                                 |
|--------------------------|----------------------------------------|-------------------------------------------------------------------------|
| `tool.execute.before`    | inside `tool-runner.ts`, pre-handler   | Mutate args, short-circuit with `rejected` / `denied` / `failure`.      |
| `tool.execute.after`     | inside `tool-runner.ts`, post-handler  | Observe + transform `ToolResult` (logging, metrics, redact).            |
| `chat.params`            | `phases/main.ts` + `phases/stream.ts`  | Mutate `{ model, messages, tools, temperature, max_tokens }` pre-call.  |
| `chat.system.transform`  | `phases/pre.ts`                        | Append / rewrite system prompt blocks (executive summary, guardrails).  |
| `permission.ask`         | inside `tool-runner.ts`, pre-handler   | Synchronous gate for "destructive / external" tools (default: allow).   |

Order semantics: hooks run in the order plugins were registered in
`INTERNAL_PLUGINS`. Each hook is wrapped in `try/catch`; a thrown hook is
logged via `logger.error("plugin", ...)` and the pipeline continues with
the next hook (error isolation). A hook that returns a `ToolResult` other
than `success` short-circuits the remaining `tool.execute.before` hooks
**and** the handler itself; the after-hooks still run on the short-circuit
result.

## ToolResult — 5-variant discriminated union

Today (`packages/agent/src/mcp/types.ts`):

```ts
export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string } | string;
}
```

After A2 (`packages/plugin/types.ts`):

```ts
export type ToolResult =
  | { kind: "success"; data: unknown }
  | { kind: "failure"; error: { code: string; message: string } }   // handler crashed / upstream 5xx
  | { kind: "rejected"; error: { code: string; message: string } }  // input/policy rejected (validators, schema)
  | { kind: "denied"; error: { code: string; message: string } }    // permission.ask returned false
  | { kind: "timeout"; error: { code: string; message: string; timeout_ms: number } };
```

Compat shim: `toLegacy(r): { success, data?, error? }` keeps existing log
serialization and the "stringified JSON in tool_result" contract identical
byte-for-byte for `success` and `failure` variants. `rejected | denied |
timeout` map to `{success:false, error:{code, message}}` in the legacy
shape so the LLM sees the same shape it does today.

## Plugin migration list (4 internal plugins)

| Plugin name                          | Replaces                                                                       | Hook(s)                                                                    | Guarded tool(s)                          |
|--------------------------------------|--------------------------------------------------------------------------------|----------------------------------------------------------------------------|------------------------------------------|
| `@subbrain/plugin-code-tool-guards`  | `packages/agent/src/pipeline/agent-loop/code-tools/code-tool-validators.ts`                   | `tool.execute.before`                                                      | `create_code_tool`, `edit_code_tool`     |
| `@subbrain/plugin-tg-gates`          | `packages/agent/src/mcp/registry/telegram-spam-gate.ts`                                       | `tool.execute.before`                                                      | `tg_send_message`                        |
| `@subbrain/plugin-scheduled-blacklist` | `packages/agent/src/pipeline/agent-loop/code-tools/scheduled-blacklist.ts` (`STATEFUL_CLIENT_CODE_TOOLS`) | conditional registration when `agentMode === "scheduled"`; `tool.execute.before` | scheduled `code_*` tools matching the blacklist |
| `@subbrain/plugin-freelance-scout`   | `packages/agent/packages/agent/src/scheduler/freelance/*`                                                    | none in A2 — wrapped as plugin shell only (scheduler keeps running)        | n/a                                      |

External behavior is byte-identical to current main: the same regex
patterns, the same `focus_blocked` error string, the same hidden-from-LLM
behavior in `scheduled` mode.

## Sequence (9 packets)

Run packets sequentially. Each packet is self-contained; do not merge
diffs across packets. Packets A2-1 through A2-5 build the framework;
A2-6 through A2-9 migrate the gates and wire boot-time registration.

A2-6 and A2-7 are **security-adjacent**: a silent regression in the
spam-gate or hardcoded-fact validator re-opens the 27.04.2026 free-agent
fake-digest incident (see `docs/tasks/code-tools-poisoning-fix.md` and
`~/vault/RLM/Daily/2026-04-28.md`). Both packets require an integration
test that exercises the original failure mode against the plugin path.

---

## Packet A2-1 — `packages/plugin/types.ts`

```json
{
  "task_id": "A2-1",
  "goal": "Define Plugin/Hooks/ToolDefinition/ToolResult type surface in packages/plugin/types.ts and re-export from packages/plugin/index.ts.",
  "non_goals": [
    "Do not implement the hooks dispatcher (that is A2-2).",
    "Do not modify any file under src/ or packages/agent/.",
    "Do not export runtime helpers; this package is types-only.",
    "Do not add npm publish config or version bumps."
  ],
  "allowed_write_paths": [
    "packages/plugin/types.ts",
    "packages/plugin/index.ts",
    "packages/plugin/package.json"
  ],
  "read_context": [
    "docs/specs/subbrain-main.md:544-625",
    "docs/tasks/runtime-arch/A2-plugin-runtime.md",
    "packages/agent/src/mcp/types.ts",
    "packages/agent/src/mcp/registry/tool-registry.ts:120-160",
    "packages/agent/src/pipeline/agent-loop/tool-runner.ts:95-200"
  ],
  "risk_tier": "public-api",
  "acceptance": [
    "test -f packages/plugin/types.ts",
    "test -f packages/plugin/index.ts",
    "bunx tsc --noEmit -p packages/plugin/tsconfig.json",
    "grep -q 'export type ToolResult' packages/plugin/types.ts",
    "grep -q '\"kind\": \"success\"' packages/plugin/types.ts || grep -q 'kind: \"success\"' packages/plugin/types.ts",
    "grep -q '\"kind\": \"timeout\"' packages/plugin/types.ts || grep -q 'kind: \"timeout\"' packages/plugin/types.ts",
    "grep -q 'export interface Plugin' packages/plugin/types.ts",
    "grep -q 'export interface Hooks' packages/plugin/types.ts",
    "grep -q 'export function tool' packages/plugin/types.ts || grep -q 'export const tool' packages/plugin/types.ts"
  ],
  "diff_budget_loc": 180,
  "file_count_max": 3,
  "rollback": "git restore packages/plugin/.",
  "escalation_triggers": [
    "packages/plugin/ does not exist (A1 not merged) — escalate, do not create the workspace.",
    "Existing packages/plugin/types.ts already defines a Hooks interface with a different shape — escalate before overwriting.",
    "Spec contradicts code: e.g. tool-registry.ts ToolResult is not the union from packages/agent/src/mcp/types.ts — escalate."
  ],
  "glossary": {
    "Plugin": "{ name: string; setup(api: { hooks: Hooks }): void | Promise<void> }",
    "Hooks": "Registry with five register methods: onToolBefore, onToolAfter, onChatParams, onChatSystemTransform, onPermissionAsk.",
    "ToolDefinition": "{ name: string; description: string; input: TSchema; scope: 'public' | 'agent-only'; handler(args, ctx): Promise<ToolResult> }",
    "tool() helper": "Identity helper that narrows the ToolDefinition for inference; no runtime logic.",
    "ToolResult": "5-variant discriminated union as defined in section 'ToolResult — 5-variant discriminated union' of this file."
  }
}
```

---

## Packet A2-2 — Hooks dispatcher core

```json
{
  "task_id": "A2-2",
  "goal": "Implement HooksDispatcher class in packages/agent/hooks/dispatcher.ts that registers and runs the five hooks in registration order with try/catch isolation per hook.",
  "non_goals": [
    "Do not wire the dispatcher into tool-runner.ts (that is A2-3).",
    "Do not wire it into chat phases (that is A2-4).",
    "Do not load INTERNAL_PLUGINS yet (that is A2-9).",
    "Do not add async-iterator hooks; all hooks are awaited sequentially."
  ],
  "allowed_write_paths": [
    "packages/agent/hooks/dispatcher.ts",
    "packages/agent/hooks/index.ts",
    "packages/agent/hooks/dispatcher.test.ts"
  ],
  "read_context": [
    "docs/tasks/runtime-arch/A2-plugin-runtime.md",
    "packages/plugin/types.ts",
    "packages/core/src/lib/logger.ts:1-80"
  ],
  "risk_tier": "public-api",
  "acceptance": [
    "test -f packages/agent/hooks/dispatcher.ts",
    "bun test packages/agent/hooks/dispatcher.test.ts",
    "bunx tsc --noEmit",
    "grep -c 'try {' packages/agent/hooks/dispatcher.ts | awk '{ exit ($1 < 5) }'",
    "grep -q 'logger.error' packages/agent/hooks/dispatcher.ts"
  ],
  "diff_budget_loc": 250,
  "file_count_max": 3,
  "rollback": "git restore packages/agent/hooks/.",
  "escalation_triggers": [
    "packages/agent/ workspace missing — escalate, do not create.",
    "logger contract from packages/core/src/lib/logger.ts disagrees with the (stage, message, extra) signature documented in CLAUDE.md — escalate.",
    "Three identical bun:test red runs on the same assertion — escalate, do not loop."
  ],
  "glossary": {
    "registration order": "Plugins are stored in an array; hooks fire in array index order. No priority field.",
    "error isolation": "A throw inside hook N is caught, logged via logger.error('plugin', name, { err }), and hook N+1 still runs.",
    "short-circuit": "If a tool.execute.before hook returns ToolResult with kind != 'success', the dispatcher returns that result immediately and skips remaining before-hooks and the handler. After-hooks still observe the short-circuit result."
  }
}
```

---

## Packet A2-3 — Wire `tool.execute.before/after` into tool-runner

```json
{
  "task_id": "A2-3",
  "goal": "Insert before/after hook dispatch around the registry call in packages/agent/src/pipeline/agent-loop/tool-runner.ts so that hookless calls produce byte-identical tool_result strings versus main.",
  "non_goals": [
    "Do not change the legacy 'done' control-signal short-circuit at tool-runner.ts:155-160.",
    "Do not move the timeout race to a hook (timeout still emits ToolResult kind:'timeout' from withToolTimeout).",
    "Do not migrate any existing gate yet (that is A2-6/A2-7/A2-8).",
    "Do not add new exported symbols beyond a HooksDispatcher injection point on ToolRunnerDeps.",
    "Do not wire permission.ask here (that is A2-4)."
  ],
  "allowed_write_paths": [
    "packages/agent/src/pipeline/agent-loop/tool-runner.ts",
    "packages/agent/src/pipeline/agent-loop/tool-dispatch.ts",
    "tests/agent-loop-hooks.test.ts"
  ],
  "read_context": [
    "packages/agent/src/pipeline/agent-loop/tool-runner.ts",
    "packages/agent/src/pipeline/agent-loop/tool-dispatch.ts",
    "packages/agent/hooks/dispatcher.ts",
    "packages/plugin/types.ts"
  ],
  "risk_tier": "public-api",
  "acceptance": [
    "bun test tests/agent-loop-hooks.test.ts",
    "bun test tests/mcp-tools.test.ts",
    "bunx tsc --noEmit",
    "node -e 'const s = require(\"fs\").readFileSync(\"packages/agent/src/pipeline/agent-loop/tool-runner.ts\",\"utf8\"); if (!/hooks/i.test(s)) process.exit(1)'"
  ],
  "diff_budget_loc": 260,
  "file_count_max": 3,
  "rollback": "git restore packages/agent/src/pipeline/agent-loop/tool-runner.ts packages/agent/src/pipeline/agent-loop/tool-dispatch.ts tests/agent-loop-hooks.test.ts",
  "escalation_triggers": [
    "ToolRunnerDeps shape change breaks more than 3 callers — escalate to split this packet.",
    "Existing tests in tests/mcp-tools.test.ts go red even with zero hooks registered — escalate (proves the hookless path is not byte-identical).",
    "withToolTimeout already emits a non-legacy shape — escalate before changing it."
  ],
  "glossary": {
    "hookless path": "When HooksDispatcher has zero registered hooks, executeAgentTool must produce the same string result as today, including the 'done' raw-string special case.",
    "byte-identical": "Same characters, same JSON key order, same error.code values."
  }
}
```

---

## Packet A2-4 — Wire `chat.params` + `chat.system.transform` + `permission.ask`

```json
{
  "task_id": "A2-4",
  "goal": "Wire chat.params and chat.system.transform into packages/agent/src/pipeline/agent-pipeline/phases/{pre,main,stream}.ts and permission.ask into the tool-runner pre-handler stage; default behavior with zero hooks is unchanged.",
  "non_goals": [
    "Do not migrate any existing system-prompt logic into a plugin (that is A2-9 wiring only).",
    "Do not introduce a new permission UX (Telegram approval, etc.); permission.ask default returns true synchronously.",
    "Do not change SSE chunking or streaming semantics in stream.ts.",
    "Do not refactor phases/pre.ts:exec-summary.ts."
  ],
  "allowed_write_paths": [
    "packages/agent/src/pipeline/agent-pipeline/phases/pre.ts",
    "packages/agent/src/pipeline/agent-pipeline/phases/main.ts",
    "packages/agent/src/pipeline/agent-pipeline/phases/stream.ts",
    "packages/agent/src/pipeline/agent-loop/tool-runner.ts"
  ],
  "read_context": [
    "packages/agent/src/pipeline/agent-pipeline/phases/pre.ts",
    "packages/agent/src/pipeline/agent-pipeline/phases/main.ts",
    "packages/agent/src/pipeline/agent-pipeline/phases/stream.ts",
    "packages/agent/src/pipeline/agent-loop/tool-runner.ts",
    "packages/agent/hooks/dispatcher.ts",
    "packages/plugin/types.ts"
  ],
  "risk_tier": "public-api",
  "acceptance": [
    "bun test tests/agent-pipeline.test.ts",
    "bun test tests/agent-loop-hooks.test.ts",
    "bunx tsc --noEmit",
    "grep -q 'chat.system.transform\\|onChatSystemTransform' packages/agent/src/pipeline/agent-pipeline/phases/pre.ts",
    "grep -q 'chat.params\\|onChatParams' packages/agent/src/pipeline/agent-pipeline/phases/main.ts",
    "grep -q 'permission.ask\\|onPermissionAsk' packages/agent/src/pipeline/agent-loop/tool-runner.ts"
  ],
  "diff_budget_loc": 280,
  "file_count_max": 4,
  "rollback": "git restore packages/agent/src/pipeline/agent-pipeline/phases/ packages/agent/src/pipeline/agent-loop/tool-runner.ts",
  "escalation_triggers": [
    "phases/main.ts and phases/stream.ts duplicate ChatParams construction in incompatible shapes — escalate to extract a shared builder before wiring chat.params.",
    "permission.ask UX is unclear (sync? async? Telegram approval?) — implement <PERMISSION_ASK_UX> placeholder = synchronous return true (default allow); flag follow-up issue.",
    "exec-summary.ts already mutates the system prompt in a way that conflicts with chat.system.transform ordering — escalate.",
    "A2-3 changes to tool-runner.ts are not present in the working tree when A2-4 starts — A2-4 builds on A2-3; ensure sequential execution."
  ],
  "glossary": {
    "ChatParams": "{ model: string; messages: Message[]; tools?: ToolDef[]; temperature?: number; max_tokens?: number; stream?: boolean }.",
    "permission.ask default": "Synchronous Promise<boolean> resolving true. No actual prompt UI in A2.",
    "<PERMISSION_ASK_UX>": "Placeholder for future approval UX (Telegram inline button, web dialog). Default true keeps current behavior."
  }
}
```

---

## Packet A2-5 — Extend `ToolResult` to 5 variants + legacy compat

```json
{
  "task_id": "A2-5",
  "goal": "Add the 5-variant discriminated union alongside the existing ToolResult in packages/agent/src/mcp/types.ts, add toLegacy() shim, and update every direct caller in packages/agent/src/mcp/registry/*, packages/agent/src/mcp/tools/*, packages/agent/src/mcp/executor/index.ts, and packages/agent/src/pipeline/agent-loop/tool-runner.ts to construct results via the new union while preserving the on-the-wire legacy JSON shape.",
  "non_goals": [
    "Do not migrate gates to plugins (A2-6/A2-7/A2-8).",
    "Do not change the `error` field ordering in serialized JSON — legacy parsers depend on it.",
    "Do not delete the old interface in the same packet; export it as `LegacyToolResult` for one release cycle.",
    "Do not introduce a new error code namespace; reuse existing codes (timeout, focus_blocked, hardcoded_facts, sandbox_violation)."
  ],
  "allowed_write_paths": [
    "packages/agent/src/mcp/types.ts",
    "packages/agent/src/mcp/registry/tool-registry.ts",
    "packages/agent/src/pipeline/agent-loop/tool-runner.ts",
    "tests/tool-result-shape.test.ts"
  ],
  "read_context": [
    "packages/agent/src/mcp/types.ts",
    "packages/agent/src/mcp/registry/tool-registry.ts",
    "packages/agent/src/mcp/registry/code-mgmt.tools.ts",
    "packages/agent/src/mcp/registry/telegram.tools.ts",
    "packages/agent/src/mcp/registry/telegram-spam-gate.ts",
    "packages/agent/src/pipeline/agent-loop/tool-runner.ts",
    "packages/plugin/types.ts"
  ],
  "risk_tier": "public-api",
  "acceptance": [
    "bun test",
    "bunx tsc --noEmit",
    "bun test tests/tool-result-shape.test.ts",
    "grep -q 'kind:\\s*\"success\"\\|kind: \"success\"' packages/agent/src/mcp/types.ts",
    "grep -q 'export function toLegacy' packages/agent/src/mcp/types.ts || grep -q 'export const toLegacy' packages/agent/src/mcp/types.ts"
  ],
  "diff_budget_loc": 290,
  "file_count_max": 4,
  "rollback": "git restore packages/agent/src/mcp/ packages/agent/src/pipeline/agent-loop/tool-runner.ts tests/tool-result-shape.test.ts",
  "escalation_triggers": [
    "More than ~25 call sites need updating — escalate to split into A2-5a (types + shim) and A2-5b (caller migration).",
    "Any caller currently returns `{success:false}` without an `error` field — escalate; the new union forbids that.",
    "Existing tests assert on the literal string \"success\":true in JSON output — escalate before changing serialization order."
  ],
  "glossary": {
    "legacy shape": "{ success: boolean; data?: unknown; error?: { code, message } | string }",
    "toLegacy(r)": "Pure function: success → {success:true, data}; failure|rejected|denied|timeout → {success:false, error:{code, message}}.",
    "wire format": "Today the LLM sees JSON.stringify(toolResult) inside tool_result. After A2 it sees JSON.stringify(toLegacy(toolResult)). Same bytes."
  }
}
```

---

## Packet A2-6 — Migrate `code-tool-validators` to internal plugin

```json
{
  "task_id": "A2-6",
  "goal": "Move packages/agent/src/pipeline/agent-loop/code-tools/code-tool-validators.ts into packages/agent/plugins-internal/code-tool-guards/ as a Plugin that registers a tool.execute.before hook on create_code_tool and edit_code_tool; remove the inline applyCodeToolGuards calls from packages/agent/src/mcp/registry/code-mgmt.tools.ts.",
  "non_goals": [
    "Do not change the regex patterns in HARDCODED_FACT_PATTERNS or SANDBOX_FORBIDDEN.",
    "Do not change the warn-vs-reject thresholds (1 match = warn, ≥2 = reject).",
    "Do not change the literal error strings 'sandbox_violation: …' or 'hardcoded_facts: …' — log assertions depend on them.",
    "Do not register this plugin in INTERNAL_PLUGINS yet (that is A2-9)."
  ],
  "allowed_write_paths": [
    "packages/agent/plugins-internal/code-tool-guards/index.ts",
    "packages/agent/plugins-internal/code-tool-guards/patterns.ts",
    "packages/agent/src/mcp/registry/code-mgmt.tools.ts",
    "tests/plugin-code-tool-guards.test.ts"
  ],
  "read_context": [
    "packages/agent/src/pipeline/agent-loop/code-tools/code-tool-validators.ts",
    "packages/agent/src/mcp/registry/code-mgmt.tools.ts",
    "docs/tasks/code-tools-poisoning-fix.md",
    "packages/plugin/types.ts",
    "packages/agent/hooks/dispatcher.ts"
  ],
  "risk_tier": "security",
  "acceptance": [
    "bun test tests/plugin-code-tool-guards.test.ts",
    "bun test tests/code-tool-validators.test.ts",
    "bunx tsc --noEmit",
    "test ! -f packages/agent/src/pipeline/agent-loop/code-tools/code-tool-validators.ts || grep -q '@deprecated' packages/agent/src/pipeline/agent-loop/code-tools/code-tool-validators.ts",
    "grep -q 'create_code_tool' packages/agent/plugins-internal/code-tool-guards/index.ts",
    "grep -q 'edit_code_tool' packages/agent/plugins-internal/code-tool-guards/index.ts"
  ],
  "notes": [
    "tests/code-tool-validators.test.ts may not exist yet; if absent, the plugin test (tests/plugin-code-tool-guards.test.ts) MUST cover the same HARDCODED_FACT_PATTERNS + SANDBOX_FORBIDDEN scenarios.",
    "Plugin files must stay under 150 lines total (blank+comments+code). If patterns.ts + index.ts together exceed 160, escalate to split patterns into a data file."
  ],
  "diff_budget_loc": 250,
  "file_count_max": 4,
  "rollback": "git restore packages/agent/src/pipeline/agent-loop/code-tools/code-tool-validators.ts packages/agent/src/mcp/registry/code-mgmt.tools.ts && git rm -rf packages/agent/plugins-internal/code-tool-guards",
  "escalation_triggers": [
    "Integration test cannot reproduce the original poisoning case (≥2 hardcoded patterns → reject) via the plugin path — STOP, do not merge; spam protection silently regressed.",
    "The plugin path produces a different ToolResult kind than the inline path produced previously — escalate; LLM-visible behavior must be identical.",
    "More than one caller of applyCodeToolGuards exists outside packages/agent/src/mcp/registry/code-mgmt.tools.ts — escalate."
  ],
  "glossary": {
    "integration test (mandatory)": "tests/plugin-code-tool-guards.test.ts must include a fixture with ≥2 patterns from HARDCODED_FACT_PATTERNS (e.g. person-name + tg-chat-id-literal) and assert the plugin returns ToolResult kind='rejected' with the literal error string starting 'hardcoded_facts:'.",
    "F-2": "docs/tasks/code-tools-poisoning-fix.md fix #2 — hardcoded-fact patterns. Background: 27.04.2026 incident, ~/vault/RLM/Daily/2026-04-28.md."
  }
}
```

---

## Packet A2-7 — Migrate `telegram-spam-gate` to internal plugin

```json
{
  "task_id": "A2-7",
  "goal": "Move packages/agent/src/mcp/registry/telegram-spam-gate.ts into packages/agent/plugins-internal/tg-gates/ as a Plugin that registers tool.execute.before on tg_send_message; remove the inline checkSpamGate call from packages/agent/src/mcp/registry/telegram.tools.ts.",
  "non_goals": [
    "Do not change the focus key 'no_repetitive_tg_spam' or the 7-day TTL.",
    "Do not change the literal error string 'focus_blocked: layer1_focus.no_repetitive_tg_spam active …' — log assertions and migration scripts depend on it.",
    "Do not block interactive mode; the plugin must short-circuit only when ctx.agentMode === 'scheduled'.",
    "Do not register this plugin in INTERNAL_PLUGINS yet (that is A2-9)."
  ],
  "allowed_write_paths": [
    "packages/agent/plugins-internal/tg-gates/index.ts",
    "packages/agent/src/mcp/registry/telegram.tools.ts",
    "packages/agent/src/mcp/registry/telegram-spam-gate.ts",
    "tests/plugin-tg-spam-gate.test.ts"
  ],
  "read_context": [
    "packages/agent/src/mcp/registry/telegram-spam-gate.ts",
    "packages/agent/src/mcp/registry/telegram.tools.ts",
    "docs/tasks/code-tools-poisoning-fix.md",
    "packages/plugin/types.ts",
    "packages/agent/hooks/dispatcher.ts"
  ],
  "risk_tier": "security",
  "acceptance": [
    "bun test tests/plugin-tg-spam-gate.test.ts",
    "bun test tests/mcp-tools.test.ts",
    "bunx tsc --noEmit",
    "grep -q 'tg_send_message' packages/agent/plugins-internal/tg-gates/index.ts",
    "grep -q 'no_repetitive_tg_spam' packages/agent/plugins-internal/tg-gates/index.ts",
    "test ! -f packages/agent/src/mcp/registry/telegram-spam-gate.ts || grep -q '@deprecated' packages/agent/src/mcp/registry/telegram-spam-gate.ts"
  ],
  "notes": [
    "tests/mcp-tools.test.ts may not cover the tg_send_message spam-gate path today. If it does not, the plugin test (tests/plugin-tg-spam-gate.test.ts) MUST reproduce both scheduled-block and interactive-pass cases."
  ],
  "diff_budget_loc": 220,
  "file_count_max": 4,
  "rollback": "git restore packages/agent/src/mcp/registry/telegram.tools.ts packages/agent/src/mcp/registry/telegram-spam-gate.ts && git rm -rf packages/agent/plugins-internal/tg-gates",
  "escalation_triggers": [
    "Integration test cannot reproduce the spam-gate block: scheduled mode + fresh focus key + tg_send_message must yield ToolResult kind='rejected' with error.code starting 'focus_blocked' — if not reproduced, STOP, do not merge.",
    "Interactive mode test fails (tg_send_message must pass through with focus key set) — escalate; bypass for human-in-the-loop is mandatory.",
    "checkSpamGate has callers outside packages/agent/src/mcp/registry/telegram.tools.ts — escalate."
  ],
  "glossary": {
    "integration test (mandatory)": "tests/plugin-tg-spam-gate.test.ts must seed layer1_focus.no_repetitive_tg_spam with non-empty value updated_at = now-1h, then call tg_send_message with agentMode='scheduled' and assert kind='rejected' + error.code='focus_blocked'; second case agentMode='interactive' must yield kind='success'.",
    "F-4": "docs/tasks/code-tools-poisoning-fix.md fix #4 — scheduled-only hard-gate."
  }
}
```

---

## Packet A2-8 — Migrate `STATEFUL_CLIENT_CODE_TOOLS` blacklist + freelance-scout shell

```json
{
  "task_id": "A2-8",
  "goal": "Move packages/agent/src/pipeline/agent-loop/code-tools/scheduled-blacklist.ts into packages/agent/plugins-internal/scheduled-blacklist/ as a context-conditional Plugin loaded only when ctx.agentMode === 'scheduled'; wrap packages/agent/packages/agent/src/scheduler/freelance/* into packages/agent/plugins-internal/freelance-scout/index.ts as a no-op Plugin shell that re-exports the existing scheduler entry points.",
  "non_goals": [
    "Do not change the contents of STATEFUL_CLIENT_CODE_TOOLS (overdue_reminder, silent_projects_check, critical_clients_monitor, client_followup_check).",
    "Do not move freelance scheduler logic into the plugin file — only re-export installFreelanceScoutScheduler.",
    "Do not change the 'hidden from LLM tool list' behavior — toToolDefs('scheduled') still drives that.",
    "Do not register either plugin in INTERNAL_PLUGINS yet (that is A2-9)."
  ],
  "allowed_write_paths": [
    "packages/agent/plugins-internal/scheduled-blacklist/index.ts",
    "packages/agent/plugins-internal/freelance-scout/index.ts",
    "packages/agent/src/mcp/registry/tool-registry.ts",
    "tests/plugin-scheduled-blacklist.test.ts"
  ],
  "read_context": [
    "packages/agent/src/pipeline/agent-loop/code-tools/scheduled-blacklist.ts",
    "packages/agent/src/mcp/registry/tool-registry.ts",
    "packages/agent/packages/agent/src/scheduler/freelance/index.ts",
    "packages/server/src/app/schedulers.ts",
    "packages/plugin/types.ts",
    "packages/agent/hooks/dispatcher.ts"
  ],
  "risk_tier": "public-api",
  "acceptance": [
    "bun test tests/plugin-scheduled-blacklist.test.ts",
    "bun test tests/agent-pipeline.test.ts",
    "bunx tsc --noEmit",
    "grep -q 'STATEFUL_CLIENT_CODE_TOOLS' packages/agent/plugins-internal/scheduled-blacklist/index.ts",
    "grep -q 'installFreelanceScoutScheduler' packages/agent/plugins-internal/freelance-scout/index.ts"
  ],
  "diff_budget_loc": 220,
  "file_count_max": 4,
  "rollback": "git restore packages/agent/src/pipeline/agent-loop/code-tools/scheduled-blacklist.ts packages/agent/src/mcp/registry/tool-registry.ts && git rm -rf packages/agent/plugins-internal/scheduled-blacklist packages/agent/plugins-internal/freelance-scout",
  "escalation_triggers": [
    "Test 'tool list in scheduled mode hides STATEFUL_CLIENT_CODE_TOOLS names' fails — escalate; this is the primary defense.",
    "packages/agent/src/scheduler/freelance has more than one entry point or non-trivial start/stop lifecycle leakage — escalate before wrapping.",
    "Conditional registration design conflicts with INTERNAL_PLUGINS shape from A2-1 — escalate, do not invent a new shape."
  ],
  "glossary": {
    "context-conditional plugin": "A Plugin whose setup() inspects an injected context (here: ctx.agentMode) and only registers hooks when the predicate matches.",
    "scheduler shell wrap": "Plugin re-exports the existing installFreelanceScoutScheduler so future packets can move logic without touching call sites again."
  }
}
```

---

## Packet A2-9 — `INTERNAL_PLUGINS` registry + boot-time wire

```json
{
  "task_id": "A2-9",
  "goal": "Add packages/agent/plugins-internal.ts exporting INTERNAL_PLUGINS in fixed order [code-tool-guards, tg-gates, scheduled-blacklist, freelance-scout]; wire boot-time setup() in packages/server/src/app/bootstrap.ts so all four plugins register against the global HooksDispatcher exactly once at startup.",
  "non_goals": [
    "Do not load external plugins from subbrain.config.ts (that is A3).",
    "Do not change plugin setup signatures introduced in A2-6/A2-7/A2-8.",
    "Do not lazy-load plugins; all four register synchronously at boot.",
    "Do not gate registration behind env vars except scheduled-blacklist (which gates internally on agentMode)."
  ],
  "allowed_write_paths": [
    "packages/agent/plugins-internal.ts",
    "packages/server/src/app/bootstrap.ts",
    "packages/server/src/app/deps.ts",
    "tests/plugins-internal-boot.test.ts"
  ],
  "read_context": [
    "packages/server/src/app/bootstrap.ts",
    "packages/server/src/app/deps.ts",
    "packages/agent/plugins-internal/code-tool-guards/index.ts",
    "packages/agent/plugins-internal/tg-gates/index.ts",
    "packages/agent/plugins-internal/scheduled-blacklist/index.ts",
    "packages/agent/plugins-internal/freelance-scout/index.ts",
    "packages/agent/hooks/dispatcher.ts",
    "packages/plugin/types.ts"
  ],
  "risk_tier": "public-api",
  "acceptance": [
    "bun test",
    "bunx tsc --noEmit",
    "bun test tests/plugins-internal-boot.test.ts",
    "bun test tests/plugin-code-tool-guards.test.ts",
    "bun test tests/plugin-tg-spam-gate.test.ts",
    "bun test tests/plugin-scheduled-blacklist.test.ts",
    "grep -q 'INTERNAL_PLUGINS' packages/agent/plugins-internal.ts",
    "grep -q 'INTERNAL_PLUGINS\\|setupInternalPlugins' packages/server/src/app/bootstrap.ts"
  ],
  "diff_budget_loc": 200,
  "file_count_max": 4,
  "rollback": "git restore packages/server/src/app/bootstrap.ts packages/server/src/app/deps.ts && git rm -f packages/agent/plugins-internal.ts tests/plugins-internal-boot.test.ts",
  "escalation_triggers": [
    "Bootstrap order forces hooks to register before HooksDispatcher exists — escalate; do not silently swap order.",
    "Any of the four plugin setup() functions throws under fresh boot — STOP, fix the offending packet, do not catch and continue.",
    "Boot test sees double-registration (same hook fired twice) — escalate; idempotency must be preserved."
  ],
  "glossary": {
    "INTERNAL_PLUGINS order": "[code-tool-guards, tg-gates, scheduled-blacklist, freelance-scout]. Order matters because tool.execute.before hooks fire in registration order.",
    "boot-time wire": "packages/server/src/app/bootstrap.ts constructs HooksDispatcher, then iterates INTERNAL_PLUGINS calling setup({ hooks }) on each, before AgentPipeline / scheduler installation."
  }
}
```

---

## Cross-packet acceptance (run after A2-9 merges)

```bash
bun test
bunx tsc --noEmit
docker compose build && docker compose up -d
docker compose logs --since 60s | grep -q 'plugin' && docker compose logs --since 60s | grep -vqi 'plugin error'
```

If any of the four plugins fails to register at boot, A2 is not done.

## Out of scope (whole track)

- External plugin loader / `subbrain.config.ts` (A3).
- Multi-process / worker isolation (Variant C, anti-scope).
- Permission UX beyond synchronous default-allow (`<PERMISSION_ASK_UX>` TBD — listed in wave-plan TBDs).
- New public REST surface; hooks are an internal contract only.
- Behavior change in any tool when zero plugins are registered.

## Dependency on Phase 8a

A2-3 through A2-5 modify `tool-runner.ts` and chat phases (`pre.ts`, `main.ts`, `stream.ts`). These files are also touched by Phase 8a (approval flow). A2 must merge before 8a-2, 8a-3, 8a-4. This is a hard dependency declared in the wave-plan dependency graph.
