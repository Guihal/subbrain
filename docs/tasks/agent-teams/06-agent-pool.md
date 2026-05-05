# Agent-teams task 06 — Phase 2: agent tasks and pool

**Status:** draft contract
**Worker model:** Kimi K2.6 (single-runner work). Three packets are **strong-model-only** and Kimi must FAIL fast on them: P2-1 (schema tier), **P2-5a** (`AgentLoopRequest` public surface), **P2-7a** (`src/lib/mutex.ts` concurrency primitive).
**Risk:** medium-to-high (one schema migration + agent loop wiring + concurrency).
**Spec ref:** [docs/specs/subbrain-main.md § Phase 2](../specs/subbrain-main.md) (lines 425-441).

## Source PRDs (read-only — do not edit)

These four files are the canonical reasoning. The packets below reference them
by line. When a Kimi worker needs full design rationale, premortem, or example
SQL/prompts — open the PRD at the cited lines.

- `docs/tasks/refactor/39-prc1-agent-tasks-table.md` — schema + repo (310 lines).
- `docs/tasks/refactor/40-prc2-pool-engine.md` — pool engine + free runner +
  `done_with_artifact` (323 lines).
- `docs/tasks/refactor/41-prc3-multi-runners.md` — clear/check-tg/research/
  find-new-task runners + TG digest (383 lines).
- `docs/tasks/refactor/42-prc4-parallel-concurrency.md` — parallelism + per-type
  rate limits + type quota (365 lines).

## How packets map to PRDs

| Packet | Source PRD | Risk tier | Worker |
|---|---|---|---|
| P2-1 agent_tasks schema + repo | 39 (full) | `schema` | **escalate — must FAIL with `requires_strong_model`** |
| P2-2 admin REST endpoints | new (not in PRDs; small scaffolding) | `public-api` | Kimi |
| P2-3 pool engine skeleton | 40 §§ "Pool scheduler tick", "Файлы → Новые модули" | `ordinary` | Kimi |
| P2-4 `done_with_artifact` MCP tool | 40 § "1. done_with_artifact tool" | `public-api` | Kimi |
| P2-5a expand AgentLoopRequest surface | new (pre-req for P2-5) | `public-api` | **escalate — must FAIL with `requires_strong_model`** |
| P2-5 wire pool to AgentLoop, free runner | 40 §§ "3. Free-runner system-prompt", "4. Per-task token budget", "5. Scheduled-mode tool gating" | `ordinary` | Kimi |
| P2-6 per-type rate limits + digest aggregation | 41 §§ "1-5", 42 § "3. RateLimits" | `ordinary` | Kimi |
| P2-7a `src/lib/mutex.ts` primitive | new (pre-req for P2-7) | `ordinary` | **escalate — must FAIL with `requires_strong_model`** (concurrency primitive) |
| P2-7 parallelism behind feature flag | 42 (full) | `public-api` | Kimi |

**Ordering:** P2-1 → (P2-2 ∥ P2-3) → P2-4 → **P2-5a (strong)** → P2-5 → P2-6 → **P2-7a (strong)** → P2-7.

Hard non-goals shared by every packet (do not restate per packet — assumed):

1. No frontend rewrite in this phase.
2. No A2A integration.
3. No marketplace integration.
4. Do not touch the existing `tasks` table (Layer 4 raw_log / chat tasks).
   `agent_tasks` is **new and separate**.
5. No parallelism in P2-3..P2-6 (gated to P2-7).
6. No `git push`, no `gh` CLI, no `--no-verify`, no prod deploy from worker.

---

## P2-1 — agent_tasks table + repo (SCHEMA TIER → ESCALATE)

```json
{
  "task_id": "P2-1",
  "goal": "Create agent_tasks table via migration_19 plus repository facade and tests. Migration ownership: P3-2 owns mig17, P3-5 owns mig18, P2-1 owns mig19 (decision recorded in docs/specs/wave-plan-2026-05.md § 'Migration ownership' lines 84-92).",
  "non_goals": [
    "Do not register the repo into MemoryService consumers.",
    "Do not create done_with_artifact, pool engine, or any runner module.",
    "Do not modify any other migration function in packages/core/src/db/schema.ts.",
    "Do not touch packages/agent/src/scheduler/, packages/agent/src/pipeline/, packages/agent/src/mcp/, packages/agent/src/services/ in this packet.",
    "Do not run docker compose, ssh, gh, or git push.",
    "Do not author migration_17 or migration_18 — those are owned by P3-2 and P3-5 respectively."
  ],
  "allowed_write_paths": [
    "packages/core/src/db/schema.ts",
    "packages/core/src/db/index.ts",
    "packages/core/src/db/tables/agent-tasks.ts",
    "packages/core/src/db/tables/agent-tasks/types.ts",
    "packages/core/src/repositories/agent-tasks.repo.ts",
    "tests/agent-tasks-repo.test.ts",
    "tests/migration-19.test.ts"
  ],
  "read_context": [
    "docs/tasks/refactor/39-prc1-agent-tasks-table.md:1-310",
    "docs/specs/wave-plan-2026-05.md",
    "packages/core/src/db/schema.ts",
    "packages/core/src/db/index.ts",
    "packages/core/src/db/tables/memory/index.ts",
    "packages/core/src/repositories/memory.repo.ts"
  ],
  "merge_dependency": "P3-5 (Migration 18) MUST be merged before P2-1 dispatches. P2-1 starts work against `PRAGMA user_version = 18`; if user_version < 18 at start, return `FAIL: pre-req-missing: P3-5 not merged (user_version=N, expected 18)`.",
  "risk_tier": "schema",
  "acceptance": [
    "bunx tsc --noEmit",
    "bun run scripts/check-file-size.ts",
    "bun test tests/migration-19.test.ts",
    "bun test tests/agent-tasks-repo.test.ts",
    "bun test",
    "test \"$(wc -l < packages/core/src/db/tables/agent-tasks.ts)\" -le 150",
    "test \"$(wc -l < packages/core/src/repositories/agent-tasks.repo.ts)\" -le 150",
    "test \"$(wc -l < packages/core/src/db/tables/agent-tasks/types.ts)\" -le 80",
    "bun -e 'import {MemoryDB} from \"./src/db\"; const db=new MemoryDB(\":memory:\"); const r=db.db.query(\"PRAGMA user_version\").get(); if((r as any).user_version!==19) process.exit(1)'",
    "test -z \"$(grep -rnE 'agent_tasks|agentTasksRepo' packages/agent/src/services/ packages/agent/src/pipeline/ packages/agent/src/scheduler/ packages/server/src/routes/ 2>/dev/null)\""
  ],
  "diff_budget_loc": 280,
  "file_count_max": 7,
  "rollback": "Revert the commit; on prod restore the .pre-mig-c1 sqlite snapshot taken before deploy. Explicit SQL rollback if revert is not feasible: `DROP INDEX IF EXISTS idx_agent_tasks_status_priority_created; DROP INDEX IF EXISTS idx_agent_tasks_type_status; DROP TABLE IF EXISTS agent_tasks; PRAGMA user_version = 18;` (run inside `db.transaction()`). Migration 19 must remain idempotent — the next deploy MUST detect `user_version=18` and re-run.",
  "escalation_triggers": [
    "Kimi worker — STOP IMMEDIATELY: this packet is risk_tier=schema. Return one line: `FAIL: requires_strong_model: schema-tier task per CLAUDE.md guardrail` and do not edit any file.",
    "PRAGMA user_version is already >=19 before any edit — return `FAIL: migration-conflict: user_version=N already`.",
    "PRAGMA user_version is < 18 at start (P3-5 not merged yet) — return `FAIL: pre-req-missing: P3-5 not merged (user_version=N, expected 18)`. Do NOT attempt to bridge missing migrations.",
    "Migration ownership for 17/18/19 differs from `docs/specs/wave-plan-2026-05.md` § 'Migration ownership' (P3-2=17, P3-5=18, P2-1=19) — return `FAIL: schema_version_conflict: ownership disagrees with wave-plan-2026-05.md:84-92`. The wave-plan is the authoritative source; do NOT renegotiate from inside this packet.",
    "tests/agent-tasks-repo.test.ts shows two concurrent claimNext calls returning same id — return `FAIL: claim-race`.",
    "bun:sqlite SQLite version <3.36 (DESC partial index unsupported) — return `FAIL: sqlite-version`."
  ],
  "glossary": {
    "agent_tasks": "New SQLite table created by migration_19, see PRD 39 lines 80-108. Holds typed background tasks for the pool engine.",
    "AgentTaskRecord": "TypeScript row interface defined in packages/core/src/db/tables/agent-tasks/types.ts per PRD 39 lines 124-137.",
    "claimNext": "Atomic UPDATE...RETURNING that flips one pending row to running, see PRD 39 lines 178-189.",
    "MemoryDB": "Existing facade class in packages/core/src/db/index.ts, this packet only adds a getter agentTasksRepo.",
    "migration_19": "Per-version migration function added to packages/core/src/db/schema.ts following the migration_10..migration_18 pattern in that same file. P2-1 owns mig19; collision avoidance is recorded in docs/specs/wave-plan-2026-05.md:84-92 (P3-2=17, P3-5=18, P2-1=19)."
  }
}
```

---

## P2-2 — agent_tasks admin REST endpoints

```json
{
  "task_id": "P2-2",
  "goal": "Expose read-only list and write enqueue HTTP routes for agent_tasks under authMiddleware.",
  "non_goals": [
    "Do not add a frontend page or composable for agent_tasks in this packet.",
    "Do not expose pool runtime state (active runners, slots) — only DB rows.",
    "Do not wire any auto-scheduling or cron — routes only.",
    "Do not emit Telegram notifications from these routes.",
    "Do not add per-row PATCH/DELETE in this packet."
  ],
  "allowed_write_paths": [
    "packages/server/src/routes/agent-tasks.ts",
    "packages/server/src/app/bootstrap.ts",
    "tests/agent-tasks-routes.test.ts"
  ],
  "read_context": [
    "docs/tasks/refactor/39-prc1-agent-tasks-table.md:34-66",
    "packages/server/src/routes/memory.ts",
    "packages/server/src/routes/freelance.ts",
    "packages/core/src/lib/api-envelope.ts",
    "packages/core/src/lib/auth.ts"
  ],
  "risk_tier": "public-api",
  "acceptance": [
    "bunx tsc --noEmit",
    "bun run scripts/check-file-size.ts",
    "bun test tests/agent-tasks-routes.test.ts",
    "bun test tests/auth.test.ts",
    "bun test tests/auth-coverage.test.ts",
    "bun test",
    "test \"$(wc -l < packages/server/src/routes/agent-tasks.ts)\" -le 150",
    "grep -nE 'paginate\\(|PaginatedResponse' packages/server/src/routes/agent-tasks.ts",
    "grep -nE 'authMiddleware' packages/server/src/routes/agent-tasks.ts",
    "test -z \"$(grep -nE 'SELECT|INSERT INTO|UPDATE .* SET|DELETE FROM' packages/server/src/routes/agent-tasks.ts)\""
  ],
  "diff_budget_loc": 220,
  "file_count_max": 3,
  "rollback": "Revert the commit; routes vanish, agent_tasks table untouched.",
  "escalation_triggers": [
    "P2-1 not merged on main (agentTasksRepo missing on MemoryDB) — return `FAIL: pre-req-missing: P2-1 not merged`.",
    "AgentTasksRepository lacks a method needed by a route — STOP, do not add SQL inside the route; return `FAIL: scope: repo lacks <method>`.",
    "More than 3 endpoints implied by the spec — STOP, return `FAIL: scope: spec contradicts file_count_max`."
  ],
  "glossary": {
    "PaginatedResponse": "Envelope type {items, total} from packages/core/src/lib/api-envelope.ts, used by routes/memory.ts and routes/freelance.ts.",
    "authMiddleware": "Bearer-token middleware exported from packages/core/src/lib/auth.ts (Elysia plugin); every route in this packet must be behind it.",
    "Elysia TypeBox": "t.Object/t.Literal/t.Union schemas used for body and query validation; see packages/server/src/routes/memory.ts for the canonical pattern.",
    "agent_tasks": "Table created by P2-1 migration_19."
  }
}
```

Required endpoints (closed set):

- `GET /v1/agent-tasks?status=&type=&limit=&offset=` — paginated list via repo.
- `GET /v1/agent-tasks/:id` — single row or 404.
- `POST /v1/agent-tasks` — body `{type, prompt, priority?, scheduledAt?, createdBy:"user"}`; delegates to `agentTasksRepo.enqueue`.

Validation: `type` is `t.Union([t.Literal("free"), t.Literal("clear"), t.Literal("check-tg"), t.Literal("research"), t.Literal("find-new-task")])`. `prompt` `t.String({minLength:1, maxLength:8000})`.

---

## P2-3 — Pool engine skeleton (single-runner, no parallelism)

```json
{
  "task_id": "P2-3",
  "goal": "Add agent-pool scheduler with single-runner tick that claims one pending task and persists complete/noop/failed.",
  "non_goals": [
    "Do not implement any concrete runner (free/clear/check-tg/research/find-new-task) — dispatch via injected runFn stub in this packet.",
    "Do not introduce parallelism, RunnerSlots, Mutex, Promise.allSettled fan-out in this packet.",
    "Do not register done_with_artifact tool here — done in P2-4.",
    "Do not change AgentLoop.run signature.",
    "Do not modify packages/agent/src/scheduler/free-agent.ts in this packet (legacy bridge handled in P2-5)."
  ],
  "allowed_write_paths": [
    "packages/agent/src/scheduler/agent-pool/index.ts",
    "packages/agent/src/scheduler/agent-pool/pool/index.ts",
    "packages/agent/src/scheduler/agent-pool/types.ts",
    "tests/agent-pool-engine.test.ts"
  ],
  "read_context": [
    "docs/tasks/refactor/40-prc2-pool-engine.md:62-141",
    "packages/server/src/app/schedulers.ts",
    "packages/agent/src/scheduler/free-agent.ts",
    "packages/core/src/lib/logger.ts",
    "packages/core/src/lib/model-router.ts"
  ],
  "risk_tier": "ordinary",
  "acceptance": [
    "bunx tsc --noEmit",
    "bun run scripts/check-file-size.ts",
    "bun test tests/agent-pool-engine.test.ts",
    "bun test",
    "test \"$(wc -l < packages/agent/src/scheduler/agent-pool/index.ts)\" -le 100",
    "test \"$(wc -l < packages/agent/src/scheduler/agent-pool/pool/index.ts)\" -le 100",
    "test \"$(wc -l < packages/agent/src/scheduler/agent-pool/types.ts)\" -le 80",
    "test -z \"$(grep -rnE 'Promise\\.all\\b' packages/agent/src/scheduler/agent-pool/)\"",
    "test -z \"$(grep -rnE 'as any' packages/agent/src/scheduler/agent-pool/)\"",
    "test -z \"$(grep -rnE '\\bfetch\\(' packages/agent/src/scheduler/agent-pool/)\""
  ],
  "diff_budget_loc": 250,
  "file_count_max": 4,
  "rollback": "Revert the commit; bootstrap loses the pool scheduler import.",
  "escalation_triggers": [
    "P2-1 not merged (no agentTasksRepo) — return `FAIL: pre-req-missing: P2-1`.",
    "router.isOverloaded API differs from PRD assumption — return `FAIL: api-mismatch: router.isOverloaded missing`.",
    "Need to spawn parallel ticks to make a test pass — STOP, parallelism is P2-7; return `FAIL: scope: parallelism creep`.",
    "Any of the new files would exceed its line cap (`index.ts` ≤100, `pool/index.ts` ≤100, `types.ts` ≤80) and the natural fix would be to split further inside this packet — STOP, return `FAIL: scope: file-cap exceeded`. Do not request a per-file whitelist exception in this packet; that is a separate PR per CLAUDE.md guardrail #1.",
    "`Promise.all(` (without `Settled`) appears anywhere under `packages/agent/src/scheduler/agent-pool/` — return `FAIL: promise-all-banned` per CLAUDE.md §2."
  ],
  "glossary": {
    "AgentTaskPool": "Thin facade class in packages/agent/src/scheduler/agent-pool/pool/index.ts that wraps agentTasksRepo with claim/complete/noop/fail/enqueue/markZombiesFailed; no business logic.",
    "tick": "Single iteration of the scheduler: zombie recovery → router overload check → claim one task → call injected runFn → persist outcome (PRD 40 lines 116-138).",
    "RunnerResult": "Discriminated union {status:'complete', artifact} | {status:'noop', reason} | {status:'failed', reason} defined in packages/agent/src/scheduler/agent-pool/types.ts.",
    "zombie recovery": "markZombiesFailed(now-1800) flips running rows older than 30 min to failed, see PRD 40 line 117.",
    "runFn injection": "Tick takes a (task) => Promise<RunnerResult> callback so this packet does not depend on real runners; default callback returns {status:'noop', reason:'no runner registered'}."
  }
}
```

Tick must be re-entrancy-guarded: a `tickRunning: boolean` flag in the scheduler closure with early return; see PRD 42 premortem row 4.

---

## P2-4 — `done_with_artifact` MCP tool

```json
{
  "task_id": "P2-4",
  "goal": "Register `done_with_artifact` agent-only MCP tool that validates status/artifact/reason and signals AgentLoop termination via the same control-signal pattern as the existing inline `done` tool (in `packages/agent/src/mcp/registry/agent-meta.tools.ts:28`). The handler returns `{ok:true, data:<JSON-string-or-structured>}`; agent-loop's existing terminate dispatch reads that `data` to end the loop. ToolResult shape is **unchanged**.",
  "non_goals": [
    "Do not remove or rename the existing inline `done` tool registered in packages/agent/src/mcp/registry/agent-meta.tools.ts:28.",
    "Do not change the AgentLoop terminator priority order across other unrelated tools.",
    "Do not call agent_tasks repo from this tool — pool runner persists, not the tool.",
    "Do not expose this tool to scope:'public' callers.",
    "Do not write artifacts to memory or RAG inside this handler.",
    "Do not change the ToolResult discriminated-union shape `{ok:true,data}|{ok:false,error}` — terminate is conveyed inside `data`, not as a new top-level field.",
    "Do not allow `done_with_artifact` to be honored twice in the same agent-loop run — second invocation MUST be ignored or returned as `ToolError{code:\"already_terminated\"}`; the loop terminates on the first successful call."
  ],
  "allowed_write_paths": [
    "packages/agent/src/mcp/registry/pool.tools.ts",
    "packages/agent/src/mcp/registry/index.ts",
    "packages/agent/src/mcp/tools/pool/done-with-artifact.ts",
    "tests/done-with-artifact.test.ts"
  ],
  "read_context": [
    "docs/tasks/refactor/40-prc2-pool-engine.md:92-111",
    "packages/agent/src/mcp/registry/index.ts",
    "packages/agent/src/mcp/registry/agent-meta.tools.ts",
    "packages/agent/src/pipeline/agent-loop/tool-dispatch.ts"
  ],
  "risk_tier": "public-api",
  "acceptance": [
    "bunx tsc --noEmit",
    "bun run scripts/check-file-size.ts",
    "bun test tests/done-with-artifact.test.ts",
    "bun test",
    "test \"$(wc -l < packages/agent/src/mcp/registry/pool.tools.ts)\" -le 120",
    "test \"$(wc -l < packages/agent/src/mcp/tools/pool/done-with-artifact.ts)\" -le 80",
    "grep -nE 'scope:\\s*\"agent-only\"' packages/agent/src/mcp/registry/pool.tools.ts",
    "grep -nE 'done_with_artifact' packages/agent/src/mcp/registry/pool.tools.ts",
    "grep -nE 'registerAgentMetaTools' packages/agent/src/mcp/registry/agent-meta.tools.ts",
    "test -z \"$(grep -nE 'export const ToolResult|interface ToolResult' packages/agent/src/mcp/types.ts | grep -v 'ok:\\s*true|ok:\\s*false')\""
  ],
  "diff_budget_loc": 200,
  "file_count_max": 4,
  "rollback": "Revert the commit; tool disappears from registry, existing inline `done` tool in agent-meta.tools.ts unchanged.",
  "escalation_triggers": [
    "Existing `done` tool (inline at agent-meta.tools.ts:28) starts failing tests after registry edit — return `FAIL: done-collision: existing tool broken`.",
    "AgentLoop terminator dispatch needs a structural change to the `ToolResult` shape to honor `done_with_artifact` — STOP, return `FAIL: scope: agent-loop refactor needed`. The packet's contract is: terminate is encoded inside `data` (string or structured), not as a new field.",
    "TypeBox schema requirements contradict the PRD body — return `FAIL: spec-contradicts-code: <where>`.",
    "Worker cannot find `packages/agent/src/mcp/tools/done-tool.ts` — that file does NOT exist; the existing `done` tool is inline at `packages/agent/src/mcp/registry/agent-meta.tools.ts:28`. Read that file instead, do not invent a path."
  ],
  "glossary": {
    "done_with_artifact": "New agent-only MCP tool with input schema {status: 'complete'|'noop', artifact?:{type, content, url?}, reason?}, see PRD 40 lines 95-111.",
    "ToolResult": "Discriminated union {success:true, data} | {success:false, error:{code, message}|string} from packages/agent/src/mcp/types.ts. UNCHANGED by this packet — terminate is encoded inside `data`.",
    "ToolError": "Builder for the {ok:false} branch with codes like 'validation_failed' / 'already_terminated'.",
    "scope=agent-only": "Registry filter that hides this tool from REST/MCP-public callers; only the autonomous agent loop sees it.",
    "terminate (control signal)": "Agent-loop already interprets the existing `done` tool's `data` string as a terminate signal (see packages/agent/src/pipeline/agent-loop/tool-dispatch.ts and agent-loop/index.ts). `done_with_artifact` extends that pattern: handler returns `{ok:true, data}` where `data` is either a string (legacy) or a JSON-stringified `{terminate:true, status, artifact?, reason?}`. Agent-loop parses both. NO new ToolResult field is introduced.",
    "idempotency": "AgentLoopState (or equivalent run-scoped flag) MUST track that one terminate has fired; subsequent `done`/`done_with_artifact` invocations in the same run return `ToolError{code:'already_terminated'}` and the loop does not re-emit the terminate signal."
  }
}
```

Validation rules (worker must encode):
- `status==="complete"` and `artifact` missing → `ToolError{code:"validation_failed"}`.
- `status==="noop"` and `reason` shorter than 10 chars → `ToolError{code:"validation_failed"}`.
- Otherwise → `{ok:true, data:{terminate:true, status, artifact?, reason?}}`.

---

## P2-5a — Expand `AgentLoopRequest` surface (STRONG MODEL ONLY)

```json
{
  "task_id": "P2-5a",
  "goal": "Extend `AgentLoopRequest` (packages/agent/src/pipeline/agent-loop/types.ts) with four new optional fields — `onUsage?: (u: UsageEvent) => void`, `signal?: AbortSignal`, `systemMessage?: string`, `userMessage?: string` — and thread them through `run.ts`/`stream.ts`/`step.ts` to the underlying provider call so callers (P2-5 and beyond) can supply per-run abort + token telemetry + custom prompts. Existing call sites that omit the new fields must keep working unchanged.",
  "non_goals": [
    "Do not change defaults of any existing field.",
    "Do not invent a new `UsageEvent` shape — reuse whatever the provider layer already emits (or define it adjacent to AgentLoopRequest if absent, ≤15 LOC).",
    "Do not rewire post-hippocampus or context-compressor in this packet.",
    "Do not implement a token-budget abort policy — that lives in P2-5; this packet only delivers the surface.",
    "Do not change the AgentLoop step cap, MAX_OUTPUT_TOKENS, or model defaults.",
    "Do not edit packages/agent/src/scheduler/, packages/agent/src/services/, packages/server/src/routes/, packages/agent/src/mcp/."
  ],
  "allowed_write_paths": [
    "packages/agent/src/pipeline/agent-loop/types.ts",
    "packages/agent/src/pipeline/agent-loop/run.ts",
    "packages/agent/src/pipeline/agent-loop/stream.ts",
    "packages/agent/src/pipeline/agent-loop/step.ts",
    "tests/agent-loop-request-surface.test.ts"
  ],
  "read_context": [
    "packages/agent/src/pipeline/agent-loop/types.ts",
    "packages/agent/src/pipeline/agent-loop/run.ts",
    "packages/agent/src/pipeline/agent-loop/stream.ts",
    "packages/agent/src/pipeline/agent-loop/step.ts",
    "packages/core/src/lib/model-router.ts",
    "packages/providers/src/types.ts"
  ],
  "risk_tier": "public-api",
  "acceptance": [
    "bunx tsc --noEmit",
    "bun run scripts/check-file-size.ts",
    "bun test tests/agent-loop-request-surface.test.ts",
    "bun test",
    "grep -E 'onUsage|signal|systemMessage|userMessage' packages/agent/src/pipeline/agent-loop/types.ts",
    "grep -nE 'onUsage|signal' packages/agent/src/pipeline/agent-loop/run.ts",
    "grep -nE 'systemMessage|userMessage' packages/agent/src/pipeline/agent-loop/run.ts",
    "test -z \"$(grep -rnE 'as any' packages/agent/src/pipeline/agent-loop/run.ts packages/agent/src/pipeline/agent-loop/stream.ts packages/agent/src/pipeline/agent-loop/step.ts packages/agent/src/pipeline/agent-loop/types.ts)\""
  ],
  "diff_budget_loc": 180,
  "file_count_max": 5,
  "rollback": "Revert the commit; the four optional fields disappear, every existing caller keeps compiling because the fields were optional throughout.",
  "escalation_triggers": [
    "Kimi or any weak model reaches this packet — return `FAIL: requires_strong_model: AgentLoopRequest is a public agent-loop surface; touch only with strong model per CLAUDE.md tier `public-api`` and do not edit any file.",
    "Adding `signal` requires changing the underlying provider signature in packages/providers/src/* beyond what `signal` already supports — return `FAIL: scope: provider signal threading needs separate PR`.",
    "Adding `systemMessage` would silently override the system prompt produced by `phases/pre.ts` — STOP, return `FAIL: scope: prompt precedence needs explicit decision`. Prefer documenting that `systemMessage` is appended (or replaces) before merging.",
    "Existing tests fail because a previously implicit prompt is now exposed via `systemMessage` — return `FAIL: regression: <test name>`."
  ],
  "glossary": {
    "AgentLoopRequest": "Public input type at packages/agent/src/pipeline/agent-loop/types.ts. Currently `{task, model?, maxSteps?, sessionId?, priority?, schedule?, agentMode?, agentId?}` (verified 2026-05-05). This packet adds four optional fields — no other change.",
    "UsageEvent": "Lightweight `{promptTokens, completionTokens, totalTokens}` (or whatever the provider already emits) passed to `onUsage` after each step. Define here only if the provider layer doesn't already expose a public type.",
    "signal threading": "AbortSignal is plumbed into `run.ts`/`stream.ts` and forwarded to `ModelRouter.chat`/provider calls; signal.aborted aborts the loop with stoppedReason='error' and the partial state is persisted (Layer 4 + chat row) per existing semantics.",
    "systemMessage / userMessage": "Optional overrides used by callers that already build the prompt (e.g. pool runners). When absent, agent-loop's existing prompt construction runs unchanged."
  }
}
```

This packet is a **prerequisite for P2-5**. P2-5 expects `onUsage` (token-budget abort) and `signal` (cooperative cancel) on `AgentLoopRequest`; without P2-5a those fields don't exist and P2-5 must `FAIL: pre-req-missing: AgentLoopRequest lacks onUsage/signal`.

---

## P2-5 — Wire pool to AgentLoop, add free runner, legacy bridge

```json
{
  "task_id": "P2-5",
  "goal": "Implement runFreeTask and connect the pool tick to AgentLoop.run with token budget abort plus legacy free-agent enqueue bridge. Depends on P2-5a having landed the `onUsage` / `signal` / `systemMessage` / `userMessage` fields on `AgentLoopRequest`; if those fields are absent, return `FAIL: pre-req-missing: P2-5a not merged`.",
  "non_goals": [
    "Do not implement clear/check-tg/research/find-new-task runners — P2-6 territory.",
    "Do not raise AGENT_POOL_MAX_CONCURRENT above 1 in this packet.",
    "Do not delete packages/agent/src/scheduler/free-agent.ts — bridge mode only.",
    "Do not modify AgentLoop.run signature; the surface comes from P2-5a. If `onUsage`/`signal` are missing, FAIL pre-req.",
    "Do not include the strings 'be efficient' / 'save tokens' / 'постарайся уложиться' / 'не используй tool без нужды' in the runner system prompt."
  ],
  "allowed_write_paths": [
    "packages/agent/src/scheduler/agent-pool/runners/free.ts",
    "packages/agent/src/scheduler/agent-pool/index.ts",
    "packages/agent/src/scheduler/free-agent.ts",
    ".env.example",
    "tests/agent-pool-runner-free.test.ts"
  ],
  "read_context": [
    "docs/tasks/refactor/40-prc2-pool-engine.md:144-228",
    "packages/agent/src/pipeline/agent-loop/run.ts",
    "packages/agent/src/pipeline/agent-loop/types.ts",
    "packages/agent/src/pipeline/agent-loop/code-tools/scheduled-blacklist.ts",
    "packages/agent/src/pipeline/agent-loop/code-tools/telegram-spam-gate.ts",
    "packages/agent/src/scheduler/free-agent.ts"
  ],
  "risk_tier": "ordinary",
  "acceptance": [
    "grep -E 'onUsage|signal|systemMessage|userMessage' packages/agent/src/pipeline/agent-loop/types.ts",
    "bunx tsc --noEmit",
    "bun run scripts/check-file-size.ts",
    "bun test tests/agent-pool-runner-free.test.ts",
    "bun test",
    "test \"$(wc -l < packages/agent/src/scheduler/agent-pool/runners/free.ts)\" -le 150",
    "test \"$(wc -l < packages/agent/src/scheduler/agent-pool/index.ts)\" -le 100",
    "grep -niE 'save tokens|be efficient|постарайся уложиться|не используй tool без нужды' packages/agent/src/scheduler/agent-pool/runners/free.ts | wc -l | grep -q '^0$'",
    "grep -nE 'AGENT_POOL_MAX_TOKENS_FREE' .env.example",
    "grep -nE 'legacy-free-agent' packages/agent/src/scheduler/free-agent.ts"
  ],
  "diff_budget_loc": 290,
  "file_count_max": 5,
  "rollback": "Revert the commit; pool falls back to default no-op runFn from P2-3, free-agent.ts loses bridge.",
  "escalation_triggers": [
    "P2-5a not merged — `grep -E 'onUsage|signal|systemMessage|userMessage' packages/agent/src/pipeline/agent-loop/types.ts` returns nothing — return `FAIL: pre-req-missing: P2-5a not merged (AgentLoopRequest lacks onUsage/signal/systemMessage/userMessage)`.",
    "AgentLoop.run still doesn't honor `signal`/`onUsage` despite P2-5a fields existing — return `FAIL: pre-req-incomplete: P2-5a fields not threaded`.",
    "P2-3 not merged (no PoolContext type) — return `FAIL: pre-req-missing: P2-3`.",
    "P2-4 not merged (done_with_artifact missing) — return `FAIL: pre-req-missing: P2-4`.",
    "Free runner system prompt grep finds an anti-economy phrase even after rewrite — return `FAIL: anti-economy-violation: free.ts:<line>`."
  ],
  "glossary": {
    "runFreeTask": "Async function in packages/agent/src/scheduler/agent-pool/runners/free.ts that calls AgentLoop.run with model 'teamlead', priority 'low', agentMode 'scheduled', maxSteps 50, signal from token-budget AbortController, and parses the final tool result into RunnerResult (PRD 40 lines 168-188).",
    "anti-economy": "Project rule (PRD 40 § Anti-economy reminder) banning 'save tokens'/'be efficient' phrasing in runner system prompts; positive phrasing 'use tools aggressively' required instead.",
    "agentMode='scheduled'": "Existing AgentLoop mode that activates scheduled-blacklist.ts and telegram-spam-gate.ts; this packet must NOT change those gate semantics.",
    "legacy bridge": "If AGENT_POOL_ENABLED=true and FREE_AGENT=true, free-agent.ts on startup enqueues exactly one free task with createdBy='legacy-free-agent' (PRD 40 lines 76-79); guarded by a process-lifetime flag.",
    "token budget abort": "AbortController whose abort() is called from onUsage when accumulated tokens exceed AGENT_POOL_MAX_TOKENS_FREE; runner maps the abort to {status:'failed', reason:'token_budget_exceeded'}."
  }
}
```

---

## P2-6 — Per-type rate limits and digest aggregation

```json
{
  "task_id": "P2-6",
  "goal": "Add per-type cooldown checks before claim and a daily TG digest cron that summarises 24h of agent_tasks outcomes.",
  "non_goals": [
    "Do not add new runner types in this packet (clear/check-tg/research/find-new-task land in their own follow-up packet outside this batch).",
    "Do not add real-time alert per-task TG sends except for the explicit verbose mode toggle from PRD 41 lines 222-226.",
    "Do not enable parallel concurrency — single-runner tick remains.",
    "Do not extend agent_tasks schema; reuse existing columns and indexes from P2-1.",
    "Do not call tg_send_message from any pool runner.",
    "Do not write multi-row inserts/updates outside `db.transaction()` per CLAUDE.md §6 — every batched mutation in this packet is wrapped."
  ],
  "allowed_write_paths": [
    "packages/agent/src/scheduler/agent-pool/pool/rate-limits.ts",
    "packages/agent/src/scheduler/agent-pool/digest.ts",
    "packages/agent/src/scheduler/agent-pool/index.ts",
    ".env.example",
    "tests/agent-pool-rate-limits.test.ts",
    "tests/digest-format.test.ts"
  ],
  "read_context": [
    "docs/tasks/refactor/41-prc3-multi-runners.md:188-226",
    "docs/tasks/refactor/42-prc4-parallel-concurrency.md:166-191",
    "packages/agent/src/telegram/bot/notify.ts",
    "packages/agent/src/services/memory/index.ts",
    "packages/core/src/repositories/memory.repo.ts"
  ],
  "risk_tier": "ordinary",
  "acceptance": [
    "bunx tsc --noEmit",
    "bun run scripts/check-file-size.ts",
    "bun test tests/agent-pool-rate-limits.test.ts",
    "bun test tests/digest-format.test.ts",
    "bun test",
    "test \"$(wc -l < packages/agent/src/scheduler/agent-pool/pool/rate-limits.ts)\" -le 80",
    "test \"$(wc -l < packages/agent/src/scheduler/agent-pool/digest.ts)\" -le 100",
    "test \"$(wc -l < packages/agent/src/scheduler/agent-pool/index.ts)\" -le 100",
    "grep -nE 'AGENT_POOL_DIGEST_HOUR_LOCAL' .env.example",
    "test -z \"$(grep -rnE 'Promise\\.all\\b' packages/agent/src/scheduler/agent-pool/)\"",
    "test -z \"$(grep -rnE 'INSERT INTO|UPDATE .* SET' packages/agent/src/scheduler/agent-pool/digest.ts packages/agent/src/scheduler/agent-pool/pool/rate-limits.ts)\"",
    "( ! grep -rnE 'for\\s*\\([^)]*\\)\\s*\\{[^}]*\\.(insert|update|delete)\\(' packages/agent/src/scheduler/agent-pool/ ) || grep -rnE 'db\\.transaction\\(' packages/agent/src/scheduler/agent-pool/"
  ],
  "diff_budget_loc": 270,
  "file_count_max": 6,
  "rollback": "Revert the commit; pool tick stops calling rateLimits.allow and the digest cron is removed.",
  "escalation_triggers": [
    "OWNER_TG_CHAT_ID env not set in .env.example — return `FAIL: missing-env: OWNER_TG_CHAT_ID required for digest`.",
    "P2-3..P2-5 not merged — return `FAIL: pre-req-missing: <packet>`.",
    "AgentTasksRepository lacks getCompletedSince method — STOP, do not add SQL elsewhere; return `FAIL: scope: repo lacks getCompletedSince`."
  ],
  "glossary": {
    "RateLimits": "In-memory map of {type → lastCompletionMs} with allow(type) and recordCompletion(type) methods; cooldowns from PRD 42 lines 170-189.",
    "composeDailyRollup": "Pure function in digest.ts that takes AgentTaskRecord[] and returns a TG-ready string per PRD 41 lines 202-214.",
    "composeInstantAlert": "Pure function in digest.ts that returns a TG message for a single failed/important task per PRD 41 lines 216-220.",
    "digest_mode": "layer1_focus key with values 'quiet' (default — daily rollup only) or 'verbose' (per-task instant) per PRD 41 lines 222-226.",
    "AGENT_POOL_DIGEST_HOUR_LOCAL": "Cron hour for the daily rollup tick, default 21; cron registered inside installAgentPoolScheduler so it never fires when AGENT_POOL_ENABLED=false."
  }
}
```

`check-tg` cooldown is left as data only (5 min in COOLDOWNS_MS); enforcement logic ships here so that the future check-tg runner inherits it without code change.

---

## P2-7a — Add `src/lib/mutex.ts` concurrency primitive (STRONG MODEL ONLY)

```json
{
  "task_id": "P2-7a",
  "goal": "Implement a minimal `Mutex` primitive at `src/lib/mutex.ts` exposing `acquire(): Promise<() => void>` (FIFO async wait, returns a release function) and synchronous `tryAcquire(): (() => void) | null` (returns release fn on success, null when contended). Used by P2-7's `RunnerSlots` for atomic per-type counters per CLAUDE.md §4.",
  "non_goals": [
    "Do not implement reentrant lock — single-acquire-single-release; double-acquire from the same call site MUST throw or queue, NOT silently re-enter.",
    "Do not add a timeout/deadline parameter — callers compose `AbortSignal.timeout(...)` on their own promise.",
    "Do not export a global singleton — the primitive is `class Mutex` only; ownership lives at the call site.",
    "Do not add semaphore (n>1) in this packet — that is a future PR if needed.",
    "Do not import anything outside the standard runtime (no third-party lib).",
    "Do not edit any consumer file — this packet only ships the primitive + its tests."
  ],
  "allowed_write_paths": [
    "src/lib/mutex.ts",
    "tests/mutex.test.ts"
  ],
  "read_context": [
    "CLAUDE.md",
    "docs/tasks/refactor/42-prc4-parallel-concurrency.md:121-156",
    "packages/providers/src/rate-limiter.ts"
  ],
  "risk_tier": "ordinary",
  "acceptance": [
    "bunx tsc --noEmit",
    "bun run scripts/check-file-size.ts",
    "bun test tests/mutex.test.ts",
    "bun test",
    "test \"$(wc -l < src/lib/mutex.ts)\" -le 80",
    "grep -nE 'tryAcquire' src/lib/mutex.ts",
    "grep -nE 'acquire\\s*\\(' src/lib/mutex.ts",
    "test -z \"$(grep -rnE 'src/lib/mutex' packages/agent/src/scheduler/ packages/agent/src/services/ packages/server/src/routes/ 2>/dev/null)\""
  ],
  "diff_budget_loc": 120,
  "file_count_max": 2,
  "rollback": "Revert the commit; the file vanishes. Because non_goals forbid editing any consumer, no caller breaks.",
  "escalation_triggers": [
    "Kimi or any weak model reaches this packet — return `FAIL: requires_strong_model: concurrency primitive (incorrect impl risks deadlock)`. Do not edit any file.",
    "tests/mutex.test.ts shows two concurrent `tryAcquire` returning truthy — return `FAIL: race-in-tryAcquire`.",
    "Reentrant call (same async stack acquiring twice without releasing) silently succeeds — return `FAIL: reentrancy-violation: spec forbids re-entry`.",
    "`acquire()` rejects/never resolves under fast contention in the test loop — return `FAIL: starvation`."
  ],
  "glossary": {
    "Mutex": "Class with `acquire(): Promise<() => void>` (FIFO; resolves when the lock is owned, returns a release function called exactly once) and `tryAcquire(): (() => void) | null` (synchronous attempt). No reentrancy, no timeout, no semaphore counts.",
    "tryAcquire": "Synchronous primitive returning the release function on immediate success or `null` if the lock is held. Used by `RunnerSlots` (P2-7) under load — if null, the caller skips the slot for this tick.",
    "acquire": "Promise-returning primitive. Resolves in arrival order (FIFO) when the lock becomes available. Caller MUST call the returned release function in `try/finally`.",
    "non-reentrancy": "If a holder calls `acquire`/`tryAcquire` again before releasing, behaviour is: `acquire` queues forever (deadlock-by-design — caller bug surfaces fast); `tryAcquire` returns null. The class never silently re-grants the same holder."
  }
}
```

This packet is a **prerequisite for P2-7**. P2-7 demands atomic `tryAcquire()` under Mutex (CLAUDE.md §4), but `src/lib/mutex.ts` does not currently exist; without P2-7a, P2-7 must `FAIL: pre-req-missing: src/lib/mutex.ts`.

---

## P2-7 — Parallel concurrency behind feature flag

```json
{
  "task_id": "P2-7",
  "goal": "Add RunnerSlots concurrency, claim-by-id atomic SQL, and parallel dispatch up to AGENT_POOL_MAX_CONCURRENT, all gated by env default 1 until verified. Depends on P2-7a having shipped `src/lib/mutex.ts`; if that file is absent, return `FAIL: pre-req-missing: P2-7a not merged`.",
  "non_goals": [
    "Do not change agent_tasks schema (no migration_20).",
    "Do not modify any runner's system prompt.",
    "Do not change done_with_artifact tool, digest format, or rate-limit cooldown values.",
    "Do not edit packages/agent/src/pipeline/, packages/agent/src/services/, packages/server/src/routes/.",
    "Do not replace Promise.allSettled with Promise.all anywhere.",
    "Do not implement the Mutex primitive in this packet — that is P2-7a's scope."
  ],
  "allowed_write_paths": [
    "packages/core/src/db/tables/agent-tasks.ts",
    "packages/core/src/repositories/agent-tasks.repo.ts",
    "packages/agent/src/scheduler/agent-pool/pool/concurrency.ts",
    "packages/agent/src/scheduler/agent-pool/index.ts",
    ".env.example",
    "tests/agent-pool-concurrency.test.ts",
    "tests/agent-pool-claim-race.test.ts"
  ],
  "read_context": [
    "docs/tasks/refactor/42-prc4-parallel-concurrency.md:1-365",
    "src/lib/mutex.ts",
    "packages/core/src/db/tables/agent-tasks.ts",
    "packages/agent/src/scheduler/agent-pool/index.ts"
  ],
  "risk_tier": "public-api",
  "acceptance": [
    "test -f src/lib/mutex.ts",
    "bunx tsc --noEmit",
    "bun run scripts/check-file-size.ts",
    "bun test tests/agent-pool-concurrency.test.ts",
    "bun test tests/agent-pool-claim-race.test.ts",
    "bun test",
    "test \"$(wc -l < packages/agent/src/scheduler/agent-pool/pool/concurrency.ts)\" -le 100",
    "test \"$(wc -l < packages/agent/src/scheduler/agent-pool/index.ts)\" -le 100",
    "grep -cE 'Promise\\.allSettled' packages/agent/src/scheduler/agent-pool/index.ts | grep -qvE '^0$'",
    "test 0 -eq \"$(grep -cE 'Promise\\.all\\b' packages/agent/src/scheduler/agent-pool/index.ts)\"",
    "grep -nE 'RETURNING \\*' packages/core/src/db/tables/agent-tasks.ts",
    "grep -nE \"WHERE id=\\? AND status='pending'\" packages/core/src/db/tables/agent-tasks.ts",
    "grep -nE 'AGENT_POOL_MAX_CONCURRENT=' .env.example"
  ],
  "diff_budget_loc": 290,
  "file_count_max": 7,
  "rollback": "Revert the commit; pool reverts to single-runner sequential tick.",
  "escalation_triggers": [
    "src/lib/mutex.ts not present — return `FAIL: pre-req-missing: P2-7a not merged (src/lib/mutex.ts absent)`.",
    "claim-race test shows two winners on the same id across 50 iterations — return `FAIL: claim-race`.",
    "SQLite RETURNING unsupported (version <3.35) — return `FAIL: sqlite-version`.",
    "Existing claimNext call sites would break and require touching out-of-scope code — return `FAIL: scope: claimNext callers outside allowed_write_paths`."
  ],
  "glossary": {
    "RunnerSlots": "Mutex-guarded per-type counter class in pool/concurrency.ts with async tryAcquire(type) and release(type) plus totalActive() per PRD 42 lines 121-156. Uses the `Mutex` from P2-7a (src/lib/mutex.ts).",
    "peekNextPending": "New non-mutating SELECT method on agent-tasks table per PRD 42 lines 224-230 used before claim-by-id.",
    "claim(id)": "New atomic UPDATE method on agent-tasks table: `UPDATE agent_tasks SET status='running', started_at=? WHERE id=? AND status='pending' RETURNING *`; returns null when affected rows = 0 (race lost).",
    "AGENT_POOL_MAX_CONCURRENT": "Env var; default raised to 3 in .env.example per PRD 42 line 63 but real prod toggle remains opt-in.",
    "claimNext (legacy)": "Existing single-step claim from P2-1; this packet keeps it usable or replaces every call site within the allowed_write_paths boundary."
  }
}
```

Per-type cap wiring: only `clear: 1` is configured here (matches PRD 42 lines 159-165); other types share `totalActive() < maxConcurrent`.

---

## Notes for the orchestrator

- P2-1 must be executed by a strong model (Opus / GPT-5). Kimi will return
  `FAIL: requires_strong_model` on P2-1 by design — that is the success signal.
- **P2-5a** (AgentLoopRequest surface expansion) and **P2-7a** (`src/lib/mutex.ts`
  primitive) are **strong-model-only** pre-packets too — Kimi must return
  `FAIL: requires_strong_model` on both. Dispatch them to Opus / GPT-5 before
  P2-5 / P2-7 respectively, otherwise those Kimi packets fail pre-req.
- Migration ownership: P3-2 = mig17, P3-5 = mig18, P2-1 = mig19. Locked in
  `docs/specs/wave-plan-2026-05.md` § "Migration ownership" lines 84-92. P2-1
  must NOT dispatch until P3-5 has merged (user_version=18).
- P2-2 can run in parallel with P2-3 once P2-1 is merged (no shared write paths).
- P2-3 → P2-4 → **P2-5a (strong)** → P2-5 is sequential.
- P2-6 needs P2-5; **P2-7a (strong)** then P2-7 close out the phase.
- Phase 2 closes when all nine packets (P2-1, P2-2, P2-3, P2-4, P2-5a, P2-5,
  P2-6, P2-7a, P2-7) are merged and `AGENT_POOL_ENABLED=true` has run at least
  one full daily-rollup cycle on prod with no zombie alarms.
