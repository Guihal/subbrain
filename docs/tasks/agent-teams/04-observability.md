# Agent-teams task 04 — Phase 5 Observability (OTel + Langfuse-or-Laminar)

**Status:** packetized contract
**Worker model:** Kimi K2.6 (P5-1 escalates to strong model only)
**Risk:** mixed — see per-packet `risk_tier`
**Spec:** `docs/specs/subbrain-main.md` § Phase 5
**Supersedes:** earlier 111-line draft of this file.

## Scope

Phase 5 adds OpenTelemetry instrumentation across the request →
pre → main → tools → post → writes pipeline, exports traces to a single chosen
backend (Langfuse OR Laminar), and exposes a cost/latency summary endpoint.

The existing `metrics_log` table and `src/lib/metrics.ts` aggregator are NOT
replaced — OTel runs alongside them. The summary endpoint reads `metrics_log`.

## Non-goals (apply to every packet below)

- No custom Langfuse clone or in-house trace UI.
- No polyglot tracing — exactly one tracing library (`@opentelemetry/*`).
- No removal or schema change of the `metrics_log` table.
- No exposure of trace data or summary endpoint without `authMiddleware`.
- No raw prompt/response bodies or secrets in span attributes by default.
- No mandatory tracing — `OTEL_ENABLED=false` (default) keeps app fully functional.

## Packet ordering

```
P5-1 (decision, strong-model)  ──▶  P5-2 (SDK init)
                                       │
              ┌────────────────────────┼────────────────────────┐
              ▼                        ▼                        ▼
P5-3 (pipeline phases)   P5-4 (agent-loop steps)   P5-5 (summary endpoint)
              └────────────────────────┬────────────────────────┘
                                       ▼
                            P5-6 (backend wiring; depends on P5-1 outcome)
```

P5-2..P5-5 may run in parallel after P5-2 lands. P5-6 waits on P5-1 + P5-2.

## Glossary (shared)

- **request_id** — id stamped on every request in `src/routes/chat.ts`; reused
  across pipeline phases for Layer 4 partitioning.
- **virtual role** — value from `src/lib/model-map.ts` (`teamlead`, `coder`,
  `critic`, `generalist`, `flash`, `chaos`, `memory`).
- **phase** — one of `pre | main | post | room | stream | direct`
  (files in `src/pipeline/agent-pipeline/phases/*.ts`).
- **step** — one iteration of the agent loop (`src/pipeline/agent-loop/step.ts`).
- **tool call** — dispatch in `src/pipeline/agent-loop/tool-dispatch.ts`.
- **metrics_log** — existing SQLite table (`src/db/schema.ts:218`) holding
  JSON snapshots written by `src/lib/metrics.ts:93`.

---

## P5-1 — Pick Langfuse or Laminar (DECISION)

> **STRONG-MODEL ONLY.** Architectural choice with cost, ToS, and self-host
> implications. Kimi MUST return `FAIL: requires_strong_model` immediately
> without writing any file.

```json
{
  "task_id": "P5-1",
  "goal": "Choose Langfuse OR Laminar as Subbrain trace backend and write the decision document.",
  "non_goals": [
    "Do not start SDK integration in this packet.",
    "Do not modify any file under src/ or web/.",
    "Do not pick both backends or leave the choice open."
  ],
  "allowed_write_paths": [
    "docs/specs/observability-choice.md"
  ],
  "read_context": [
    "docs/specs/subbrain-main.md:490-504",
    "docs/tasks/agent-teams/04-observability.md",
    "CLAUDE.md",
    "src/db/schema.ts:218-224",
    "src/lib/metrics.ts"
  ],
  "risk_tier": "public-api",
  "acceptance": [
    "test -f docs/specs/observability-choice.md",
    "grep -E '^## Decision: (Langfuse|Laminar)$' docs/specs/observability-choice.md",
    "grep -E '^## (Self-host|Cost|Data residency|SDK fit|Bun compatibility|Rejected alternative)' docs/specs/observability-choice.md | wc -l | awk '{ exit ($1>=5)?0:1 }'",
    "grep -F 'metrics_log' docs/specs/observability-choice.md",
    "bunx tsc --noEmit",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-deep-imports.ts"
  ],
  "diff_budget_loc": 250,
  "file_count_max": 1,
  "rollback": "Delete docs/specs/observability-choice.md and re-run the decision.",
  "escalation_triggers": [
    "Kimi or any weak model reaches this packet — return FAIL: requires_strong_model and stop.",
    "Both backends evaluate equal — escalate to user, do not pick by coin flip.",
    "Self-host of the chosen backend requires Postgres/ClickHouse the project does not run — flag and pause.",
    "Observability decision doc contradicts existing logger, metric, or pipeline semantics — FAIL: spec contradicts code, list mismatch."
  ],
  "glossary": {
    "Decision document": "Markdown file with sections Decision, Self-host, Cost, Data residency, SDK fit, Bun compatibility, Rejected alternative."
  }
}
```

---

## P5-2 — OpenTelemetry SDK init (NoOp default)

```json
{
  "task_id": "P5-2",
  "goal": "Add @opentelemetry/api and @opentelemetry/sdk-node, expose getTracer() from src/lib/telemetry.ts, default to NoOp tracer when OTEL_ENABLED is not 'true'.",
  "non_goals": [
    "Do not auto-instrument HTTP/fetch in this packet — manual spans only.",
    "Do not add any backend-specific exporter (Langfuse/Laminar) here.",
    "Do not change any pipeline file outside the allowed list.",
    "Do not register the SDK if OTEL_ENABLED !== 'true'.",
    "Do not call NodeSDK.start() more than once per process — initTelemetry must guard against double-init via a module-level flag (e.g. sdkInitialized)."
  ],
  "allowed_write_paths": [
    "src/lib/telemetry.ts",
    "src/app/bootstrap.ts",
    "package.json",
    ".env.example"
  ],
  "read_context": [
    "src/app/bootstrap.ts",
    "src/lib/logger.ts",
    "package.json",
    "docs/tasks/agent-teams/04-observability.md"
  ],
  "risk_tier": "ordinary",
  "acceptance": [
    "grep -F '@opentelemetry/api' package.json",
    "grep -F '@opentelemetry/sdk-node' package.json",
    "grep -E 'export function getTracer' src/lib/telemetry.ts",
    "grep -E 'OTEL_ENABLED' src/lib/telemetry.ts .env.example",
    "grep -E 'sdkInitialized|isInitialized|started' src/lib/telemetry.ts",
    "OTEL_ENABLED=false bunx tsc --noEmit",
    "bun -e \"import('@opentelemetry/sdk-node').then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)})\"",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-deep-imports.ts",
    "grep -F 'initTelemetry' src/app/bootstrap.ts"
  ],
  "diff_budget_loc": 200,
  "file_count_max": 4,
  "rollback": "Remove src/lib/telemetry.ts, revert bootstrap.ts hunk, drop the two @opentelemetry/* deps from package.json + bun.lock.",
  "escalation_triggers": [
    "@opentelemetry/sdk-node fails to import under Bun (verify with `bun -e \"import('@opentelemetry/sdk-node')\"`) — escalate before adding the dep.",
    "Bootstrap order conflicts with existing bootstrap.ts (initTelemetry must run before createProviders) — escalate, do not reorder unrelated init steps.",
    "package.json edit triggers bun.lock churn beyond the two new deps — stop and escalate.",
    "OTel SDK init contradicts existing bootstrap order or provider initialization — FAIL: spec contradicts code, list mismatch."
  ],
  "glossary": {
    "NoOp tracer": "Tracer returned by @opentelemetry/api when no SDK is registered; spans are created but discarded.",
    "getTracer()": "Single export of src/lib/telemetry.ts returning a tracer named 'subbrain' for use by all instrumentation packets."
  }
}
```

---

## P5-3 — Instrument pipeline phases

```json
{
  "task_id": "P5-3",
  "goal": "Wrap each pipeline phase entrypoint in a span named 'subbrain.pipeline.<phase>' with attributes subbrain.phase, subbrain.role, subbrain.request_id, subbrain.tokens.prompt, subbrain.tokens.completion.",
  "non_goals": [
    "Do not change phase business logic, return shapes, or error handling.",
    "Do not add spans inside child helpers — only at the phase entrypoint function in each listed file.",
    "Do not include raw message bodies in span attributes; do not stringify message arrays into attribute strings either — only count/length-derived primitives.",
    "Do not skip a phase file — all five must be instrumented."
  ],
  "allowed_write_paths": [
    "src/pipeline/agent-pipeline/phases/pre.ts",
    "src/pipeline/agent-pipeline/phases/main.ts",
    "src/pipeline/agent-pipeline/phases/post.ts",
    "src/pipeline/agent-pipeline/phases/room.ts",
    "src/pipeline/agent-pipeline/phases/stream.ts"
  ],
  "read_context": [
    "src/pipeline/agent-pipeline/phases/pre.ts",
    "src/pipeline/agent-pipeline/phases/main.ts",
    "src/pipeline/agent-pipeline/phases/post.ts",
    "src/pipeline/agent-pipeline/phases/room.ts",
    "src/pipeline/agent-pipeline/phases/stream.ts",
    "src/lib/telemetry.ts"
  ],
  "risk_tier": "ordinary",
  "acceptance": [
    "grep -lF 'getTracer' src/pipeline/agent-pipeline/phases/pre.ts src/pipeline/agent-pipeline/phases/main.ts src/pipeline/agent-pipeline/phases/post.ts src/pipeline/agent-pipeline/phases/room.ts src/pipeline/agent-pipeline/phases/stream.ts | wc -l | awk '{ exit ($1==5)?0:1 }'",
    "grep -RhE \"subbrain\\.pipeline\\.(pre|main|post|room|stream)\" src/pipeline/agent-pipeline/phases | wc -l | awk '{ exit ($1>=5)?0:1 }'",
    "grep -RhF 'subbrain.request_id' src/pipeline/agent-pipeline/phases | wc -l | awk '{ exit ($1>=5)?0:1 }'",
    "bunx tsc --noEmit",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-deep-imports.ts"
  ],
  "diff_budget_loc": 250,
  "file_count_max": 5,
  "rollback": "Revert the five phase files to HEAD~1.",
  "escalation_triggers": [
    "A phase file already exceeds the 150-line cap before edits — escalate, do not split. NOTE: pre.ts (145), main.ts (65), post.ts (196), room.ts (62), stream.ts (161) at packet-write time; post.ts and stream.ts ALREADY over cap. If pre-edit line count + planned diff puts file ≥150 and the file is missing from scripts/check-file-size.ts:21 whitelist, STOP and escalate; do NOT split unrelated logic to free lines.",
    "Phase function signature does not expose request_id or role — escalate, do not invent fields.",
    "Stream phase has no clean closure point for span end — escalate; do not call span.end() inside an async iterator without cancel handling.",
    "Pipeline instrumentation contradicts existing request flow or SSE semantics — FAIL: spec contradicts code, list mismatch."
  ],
  "glossary": {
    "Phase entrypoint": "The single exported function in each phase file (e.g. runPre, runMain, runPost, runRoom, runStream).",
    "Span name format": "'subbrain.pipeline.' + phase shortname (pre|main|post|room|stream)."
  }
}
```

---

## P5-4 — Instrument agent-loop steps and tool dispatch

```json
{
  "task_id": "P5-4",
  "goal": "Wrap agent-loop step execution in span 'subbrain.agent.step' and tool dispatch in span 'subbrain.tool.call', setting span status ERROR on tool failure, using tool-runner.ts:130-198 as the dispatch site.",
  "non_goals": [
    "Do not modify step iteration count, MAX_STEPS, or control flow.",
    "Do not change the ToolResult shape or replace tool-runner.ts.",
    "Do not include tool input or output payloads in span attributes — only tool name, ok flag, error code.",
    "Do not introspect ToolResult.data payload for span attributes — only the `ok` flag and `error.code` from the discriminated union per CLAUDE.md §8.",
    "Do not auto-instrument http/fetch — only the listed call sites get spans."
  ],
  "allowed_write_paths": [
    "src/pipeline/agent-loop/step.ts",
    "src/pipeline/agent-loop/tool-runner.ts"
  ],
  "read_context": [
    "src/pipeline/agent-loop/step.ts",
    "src/pipeline/agent-loop/tool-runner.ts",
    "src/pipeline/agent-loop/tool-dispatch.ts",
    "src/pipeline/agent-loop/types.ts",
    "src/lib/telemetry.ts"
  ],
  "risk_tier": "ordinary",
  "acceptance": [
    "grep -F 'subbrain.agent.step' src/pipeline/agent-loop/step.ts",
    "grep -F 'subbrain.tool.call' src/pipeline/agent-loop/tool-runner.ts",
    "grep -E 'SpanStatusCode\\.ERROR|setStatus' src/pipeline/agent-loop/tool-runner.ts",
    "grep -F 'subbrain.tool.name' src/pipeline/agent-loop/tool-runner.ts",
    "bunx tsc --noEmit",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-deep-imports.ts"
  ],
  "diff_budget_loc": 200,
  "file_count_max": 2,
  "rollback": "Revert the two agent-loop files to HEAD~1.",
  "escalation_triggers": [
    "step.ts already exceeds the 150-line cap (151 lines at packet-write time) — escalate, do not split mid-task. If pre-edit line count + planned diff puts step.ts or tool-runner.ts ≥150 and the file is missing from scripts/check-file-size.ts:21 whitelist, STOP and escalate; do NOT split unrelated logic to free lines.",
    "executeAgentTool in tool-runner.ts has multiple dispatch sites (registry + dynamic + code-tools) — instrument all three branches; if shape differs across them, escalate before guessing.",
    "Span end placement risks leaking on early throw — escalate; do not skip try/finally.",
    "Agent-loop instrumentation contradicts existing tool-runner or step.ts semantics — FAIL: spec contradicts code, list mismatch."
  ],
  "glossary": {
    "Step": "One iteration of the agent loop in src/pipeline/agent-loop/step.ts.",
    "Tool dispatch": "The executeAgentTool function in src/pipeline/agent-loop/tool-runner.ts:130-198 that resolves registry → dynamic → code-tools."
  }
}
```

---

## P5-5 — Cost/latency summary endpoint

```json
{
  "task_id": "P5-5",
  "goal": "Add GET /v1/metrics/runs?from=<unix>&to=<unix> under authMiddleware, returning aggregated metrics_log JSON with HTTP 400 when from>to.",
  "non_goals": [
    "Do not alter the metrics_log table schema.",
    "Do not extend RequestMetric or MetricsSnapshot to include virtual_role or provider — current snapshot has only `models: Record<modelId, ModelStats>`. Adding role/provider breakdown is a schema-tier change, out of scope for this packet.",
    "Do not write a new metrics aggregator if src/lib/metrics/* already exposes a reducer — reuse it.",
    "Do not return raw rows — only the aggregate object.",
    "Do not mount the route before authMiddleware."
  ],
  "allowed_write_paths": [
    "src/routes/metrics.ts",
    "src/app/bootstrap.ts",
    "tests/metrics-runs.test.ts"
  ],
  "read_context": [
    "src/db/schema.ts:215-225",
    "src/lib/metrics.ts",
    "src/lib/metrics/snapshot.ts",
    "src/routes/freelance.ts",
    "src/lib/api-envelope.ts",
    "src/app/bootstrap.ts"
  ],
  "risk_tier": "public-api",
  "acceptance": [
    "test -f src/routes/metrics.ts",
    "grep -E \"'/v1/metrics/runs'|\\\"/v1/metrics/runs\\\"\" src/routes/metrics.ts",
    "grep -F 'authMiddleware' src/app/bootstrap.ts",
    "grep -F 'metrics_log' src/routes/metrics.ts",
    "grep -E 'from *> *to|from>to|400' src/routes/metrics.ts",
    "bunx tsc --noEmit",
    "bun test tests/metrics-runs.test.ts",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-deep-imports.ts"
  ],
  "diff_budget_loc": 250,
  "file_count_max": 3,
  "rollback": "Delete src/routes/metrics.ts and tests/metrics-runs.test.ts; revert the bootstrap.ts mount hunk.",
  "escalation_triggers": [
    "metrics_log snapshot JSON has only `models` field (no per-role or per-provider breakdown in current MetricsSnapshot) — that is expected; map `models` to `by_model`. If caller demands by_role/by_provider, escalate as separate schema-tier PR; do NOT invent fields here.",
    "No timingSafeEqual auth helper available for the route — escalate, do not roll a custom compare.",
    "Range filter requires a new index on timestamp — escalate; do not add migration in this packet.",
    "Metrics endpoint contradicts existing api-envelope or auth middleware patterns — FAIL: spec contradicts code, list mismatch."
  ],
  "glossary": {
    "Run": "One row in metrics_log corresponding to one rolling snapshot written by src/lib/metrics.ts.",
    "from/to": "Unix epoch seconds; default to last 24h if both missing; reject if from>to with HTTP 400.",
    "by_model": "Map<modelId, {count, avg_latency_ms, total_cost_usd}> derived from MetricsSnapshot.models. This is the ONLY breakdown the existing snapshot supports — virtual_role and provider are NOT tracked at the request-metric layer."
  }
}
```

---

## P5-6 — Wire chosen exporter (Langfuse OR Laminar)

> Depends on P5-1 outcome. Worker MUST read `docs/specs/observability-choice.md`
> first; if absent, return `FAIL: missing_decision_doc`.

```json
{
  "task_id": "P5-6",
  "goal": "Wire the backend chosen in docs/specs/observability-choice.md as an OTLP exporter inside src/lib/telemetry.ts, gated by OTEL_ENABLED=true and OTEL_EXPORTER_OTLP_ENDPOINT.",
  "non_goals": [
    "Do not pick a backend in this packet — read the decision file.",
    "Do not start ANY edit if docs/specs/observability-choice.md is absent — the existence test of the decision doc MUST run as the first acceptance step; if it fails, exit 1 without touching any file.",
    "Do not add the second backend's SDK as a fallback.",
    "Do not enable the exporter when OTEL_ENABLED !== 'true'.",
    "Do not embed API keys in source — env vars only.",
    "Do not install the OTLP exporter at `latest` — pin to a Bun-tested version (verify via `bun -e \"import('@opentelemetry/exporter-trace-otlp-http')\"` first)."
  ],
  "allowed_write_paths": [
    "src/lib/telemetry.ts",
    "package.json",
    ".env.example",
    "docker-compose.yml"
  ],
  "read_context": [
    "docs/specs/observability-choice.md",
    "src/lib/telemetry.ts",
    "package.json",
    ".env.example",
    "docker-compose.yml"
  ],
  "risk_tier": "ordinary",
  "acceptance": [
    "test -f docs/specs/observability-choice.md",
    "grep -E 'OTEL_EXPORTER_OTLP_ENDPOINT' .env.example src/lib/telemetry.ts",
    "grep -E '@opentelemetry/exporter-trace-otlp-(http|proto)' package.json",
    "grep -E 'OTEL_ENABLED *=== *.true.' src/lib/telemetry.ts",
    "OTEL_ENABLED=false bunx tsc --noEmit",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-deep-imports.ts"
  ],
  "diff_budget_loc": 200,
  "file_count_max": 4,
  "rollback": "Revert telemetry.ts to NoOp-only state from P5-2; drop the exporter dep from package.json.",
  "escalation_triggers": [
    "docs/specs/observability-choice.md does not exist — return FAIL: missing_decision_doc and stop. Acceptance order matters: the existence test MUST run first; if it fails, exit 1 without touching any file. Do NOT begin editing telemetry.ts before the existence check passes.",
    "Chosen backend requires a side-car container that conflicts with existing docker-compose.yml services — escalate.",
    "Self-host of the chosen backend mandates Postgres/ClickHouse not present in compose — escalate, do not silently add a database.",
    "Bun-incompatible OTLP exporter — escalate before swapping protocols. If chosen OTLP variant (http vs proto) fails Bun import smoke (`bun -e \"import('@opentelemetry/exporter-trace-otlp-http')\"` or `-otlp-proto`), escalate; do not silently swap variants.",
    "OTLP wiring contradicts existing logger, metric, or env-var patterns — FAIL: spec contradicts code, list mismatch."
  ],
  "glossary": {
    "Decision file": "docs/specs/observability-choice.md produced by P5-1; contains the line 'Decision: Langfuse' or 'Decision: Laminar'.",
    "Exporter gating": "Exporter is registered only when OTEL_ENABLED === 'true' AND OTEL_EXPORTER_OTLP_ENDPOINT is non-empty."
  }
}
```

---

## Output contract (every packet)

Worker returns one of:

```text
OK <task_id>: <one-line summary>
```

```text
FAIL: <category>: <short reason>
```

Categories: `requires_strong_model`, `missing_decision_doc`, `bun_incompat`,
`spec_contradiction`, `over_budget`, `out_of_scope`.
