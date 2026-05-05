# Agent-teams task 05 — Phase 6: A2A-ready arbitration room

**Status:** open contract (Phase 6, blocked on Phase 1 + Phase 2)
**Worker model:** Kimi K2.6 (per packet)
**Risk:** mixed — packet-by-packet (one schema-tier escalation, one public-api)
**Source spec:** `docs/specs/subbrain-main.md` §"Phase 6 — A2A arbitration"
(spec lines 505-518) + §"Arbitration room" (spec lines 201-216).

## Phase 6 goal (verbatim from spec)

Make the arbitration room extensible to remote participants:

- Add participant interface.
- Keep local participants working.
- Add A2A transport adapter behind feature flag.
- Add transcript artifacts.

Non-goals (verbatim): no remote code execution; no marketplace of agents.

## Dependency gate (DO NOT START before this)

Phase 6 may begin only after **both** of the following are merged AND
declared stable on `main`:

1. **Phase 1 — Bifrost gateway** (`docs/tasks/agent-teams/01-bifrost-gateway.md`)
   feature-flag rollout complete, Bifrost provider parity verified.
2. **Phase 2 — Agent tasks and pool**
   (`docs/tasks/refactor/39-…` through `…/42-…`) — `agent_tasks` table
   landed, pool engine + `done_with_artifact` shipped.

Rationale (spec line 216): "Do not start A2A before gateway + pool are
stable." Spec edge `Phase 2 + Phase 3 + Phase 5 -> Phase 6 A2A` (line 355).

If Phase 1 or Phase 2 has not landed at packet-execution time, escalate —
do not run packets P6-1..P6-6 against unstable foundations.

## Transport-protocol resolution

The wire protocol for the A2A transport (`<A2A_TRANSPORT>`) is not
fixed in `docs/specs/subbrain-main.md`. Candidates: Google A2A
(JSON-RPC + SSE), HTTP+SSE, or gRPC. **P6-4 escalates** if
`<A2A_TRANSPORT>` is still unset at run time. P6-1..P6-3 are
transport-agnostic and may proceed.

## Hard non-goals (apply to every packet below)

1. No remote code execution from a remote participant.
2. No agent marketplace, discovery service, or registry beyond a static
   participant list in env/config.
3. No regression of local arbitration behavior — every existing test in
   `tests/arbitration.test.ts` and `tests/arbitration-abort.test.ts` must
   pass byte-identical synthesis output for local-only configs.
4. No enabling of the A2A transport by default — `A2A_ENABLED` env flag
   defaults to `false` and is read once at bootstrap.
5. No mTLS, OAuth, or full PKI between participants in this phase. A
   single shared-secret bearer token (`A2A_SHARED_SECRET`) is the only
   accepted auth in P6-4. Full mutual auth is deferred.
6. No frontend UI in this phase. Transcript viewer is a Phase 7 item.
7. No new model roles, no edits to `src/lib/model-map.ts`.

## Packet layout (6 packets)

P6-1 → P6-2 → P6-3 → P6-4 → P6-5 → P6-6 (sequential; each merges
independently). Total ≤ 6 PRs. Single packet ≤ 300 LOC, ≤ 4 files.

---

## P6-1 — Define `RoomParticipant` interface (no implementations)

```json
{
  "task_id": "P6-1",
  "goal": "Add RoomParticipant interface and ParticipantInput/ParticipantOutput types in src/pipeline/arbitration/participants.ts and re-export from src/pipeline/arbitration/types.ts.",
  "non_goals": [
    "Do not refactor dispatch.ts or index.ts in this packet.",
    "Do not add any implementation of RoomParticipant.",
    "Do not change synthesis.ts, classify.ts, weights.ts, or prompts.ts.",
    "Do not change tests.",
    "Do not export anything chain-of-thought related from ParticipantOutput."
  ],
  "allowed_write_paths": [
    "src/pipeline/arbitration/participants.ts",
    "src/pipeline/arbitration/types.ts",
    "src/pipeline/arbitration/index.ts"
  ],
  "read_context": [
    "src/pipeline/arbitration/types.ts",
    "src/pipeline/arbitration/dispatch.ts",
    "src/pipeline/arbitration/index.ts",
    "docs/specs/subbrain-main.md:505-518"
  ],
  "risk_tier": "ordinary",
  "acceptance": [
    "bunx tsc --noEmit",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-deep-imports.ts",
    "bun test tests/arbitration.test.ts tests/arbitration-abort.test.ts",
    "rg -n 'RoomParticipant' src/pipeline/arbitration/participants.ts | wc -l | awk '{ if ($1 < 1) exit 1 }'",
    "rg -n 'export type \\{[^}]*RoomParticipant' src/pipeline/arbitration/types.ts || rg -n 'export \\* from \"./participants\"' src/pipeline/arbitration/types.ts"
  ],
  "diff_budget_loc": 80,
  "file_count_max": 2,
  "rollback": "git revert the single commit; types are unused.",
  "escalation_triggers": [
    "If exporting RoomParticipant from types.ts creates a cyclic import with weights.ts, escalate.",
    "If acceptance script reports tsc errors not introduced by this packet (>0 errors on main), escalate.",
    "If existing types.ts is over the 150-line cap after edit, escalate."
  ],
  "glossary": {
    "RoomParticipant": "Pluggable interface { id: string; kind: 'local'|'remote'; capabilities: string[]; ask(input: ParticipantInput): Promise<ParticipantOutput> }.",
    "ParticipantInput": "{ userMessage: string; executiveSummary: string; category: TaskCategory; signal?: AbortSignal; timeoutMs: number }.",
    "ParticipantOutput": "{ id: string; content: string; latencyMs: number; timedOut: boolean; confidence?: number; artifacts?: unknown[] } — no chain-of-thought field."
  }
}
```

---

## P6-2 — Refactor `dispatch.ts` to consume `RoomParticipant[]`

```json
{
  "task_id": "P6-2",
  "goal": "Replace the role-string fan-out in src/pipeline/arbitration/dispatch.ts with a participant fan-out using RoomParticipant[]; introduce a LocalParticipant adapter in src/pipeline/arbitration/participants.ts that wraps router.chat with the existing prompt; index.ts builds LocalParticipant[] from RoomConfig.agents.",
  "non_goals": [
    "Do not change synthesis behavior, prompt text, or weights.",
    "Do not introduce a remote participant in this packet.",
    "Do not add new env vars.",
    "Do not change AgentResponse shape consumed by synthesis.ts.",
    "Do not edit tests; existing tests must pass byte-identical synthesis output."
  ],
  "allowed_write_paths": [
    "src/pipeline/arbitration/participants.ts",
    "src/pipeline/arbitration/dispatch.ts",
    "src/pipeline/arbitration/index.ts"
  ],
  "read_context": [
    "src/pipeline/arbitration/dispatch.ts",
    "src/pipeline/arbitration/index.ts",
    "src/pipeline/arbitration/prompts.ts",
    "src/pipeline/arbitration/synthesis.ts",
    "tests/arbitration.test.ts",
    "tests/arbitration-abort.test.ts"
  ],
  "risk_tier": "public-api",
  "acceptance": [
    "bunx tsc --noEmit",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-deep-imports.ts",
    "bun test tests/arbitration.test.ts tests/arbitration-abort.test.ts",
    "rg -n 'router.chat' src/pipeline/arbitration/dispatch.ts && exit 1 || true",
    "rg -n 'RoomParticipant' src/pipeline/arbitration/dispatch.ts",
    "wc -l src/pipeline/arbitration/dispatch.ts | awk '{ if ($1 > 150) exit 1 }'",
    "wc -l src/pipeline/arbitration/index.ts | awk '{ if ($1 > 100) exit 1 }'"
  ],
  "diff_budget_loc": 220,
  "file_count_max": 3,
  "rollback": "git revert; previous dispatch.ts restores role-string fan-out.",
  "escalation_triggers": [
    "If any existing test in tests/arbitration*.ts requires modification to pass, escalate (parity violation).",
    "If LocalParticipant cannot reproduce identical AgentResponse fields {role,content,latencyMs,timedOut} via router.chat without behavior drift, escalate.",
    "If the per-specialist AbortController + external signal propagation cannot be preserved through the new interface, escalate.",
    "If file size cap 150 is breached on dispatch.ts or 100 on index.ts, escalate.",
    "If dispatch.ts exceeds 145 lines pre-edit (currently 142), any addition >3 lines breaches cap — escalate to split dispatch.ts into dispatch.ts + local-participant.ts."
  ],
  "glossary": {
    "LocalParticipant": "RoomParticipant impl with kind='local'; ask() = current callSpecialist body — buildSpecialistSystemPrompt + router.chat + Promise.race timeout + per-specialist AbortController.",
    "parity": "Same synthesis string for the same (userMessage, executiveSummary, RoomConfig) when participants are local-only."
  }
}
```

---

## P6-3 — Persist arbitration transcripts (schema-tier — ESCALATE)

```json
{
  "task_id": "P6-3",
  "goal": "Persist per-room transcripts (participant id, kind, content, latencyMs, timedOut, synthesis input weights, final synthesis text) so future Phase 7 viewers can replay rooms; storage backend chosen by the schema-tier review (new arbitration_transcripts table OR reuse agent_tasks.artifact_payload from Phase 2) — DO NOT pick without escalation.",
  "non_goals": [
    "Do not write transcripts synchronously on the request hot path; insert in a background fire-and-forget task wrapped in db.transaction().",
    "Do not add a transcript route or UI in this packet.",
    "Do not store chain-of-thought, raw tool_calls, or provider-side reasoning fields.",
    "Do not run a destructive migration; new table only, never DROP or rename.",
    "Do not couple persistence to the A2A flag — local rooms also produce transcripts."
  ],
  "allowed_write_paths": [
    "src/db/schema.ts",
    "src/db/tables/arbitration-transcripts.ts",
    "src/db/tables/index.ts",
    "src/repositories/arbitration-transcripts.repo.ts",
    "src/pipeline/arbitration/index.ts",
    "scripts/audit-db.ts"
  ],
  "read_context": [
    "src/db/schema.ts",
    "src/db/tables/chats.ts",
    "src/repositories/chat.repository.ts",
    "src/pipeline/arbitration/index.ts",
    "docs/tasks/refactor/39-prc1-agent-tasks-table.md",
    "docs/tasks/refactor/40-prc2-pool-engine.md",
    "docs/specs/subbrain-main.md:425-442"
  ],
  "risk_tier": "schema",
  "acceptance": [
    "bunx tsc --noEmit",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-deep-imports.ts",
    "bun test tests/arbitration.test.ts tests/arbitration-abort.test.ts",
    "bun run scripts/audit-db.ts | rg -i 'arbitration_transcripts|transcripts' || true",
    "rg -n 'CREATE TABLE.*arbitration_transcripts' src/db/schema.ts || rg -n 'artifact_payload' src/db/schema.ts",
    "rg -n 'db.transaction\\(' src/pipeline/arbitration/index.ts || rg -n 'insertTranscript' src/repositories/arbitration-transcripts.repo.ts"
  ],
  "diff_budget_loc": 260,
  "file_count_max": 4,
  "rollback": "Drop the new migration (table is additive, no existing data depends on it); revert index.ts persistence call.",
  "escalation_triggers": [
    "MANDATORY ESCALATION: schema-tier — pause for human review of the chosen storage backend (new table vs agent_tasks.artifact_payload reuse) before starting.",
    "If Phase 2 (agent_tasks) has not merged, the artifact_payload reuse path is unavailable — escalate.",
    "If existing migration count + 1 conflicts with another open PR's migration number, escalate.",
    "If transcript row exceeds 64 KB for a typical 3-specialist room, escalate (cap content per participant)."
  ],
  "glossary": {
    "transcript row": "{ id, chat_id?, request_id, category, participants_json (id+kind+content+latency+timedOut+confidence?), synthesis_text, weights_json, created_at }.",
    "fire-and-forget": "void Promise.resolve().then(() => repo.insert(...)).catch(log) — does not block the arbitration return."
  }
}
```

---

## P6-4 — A2A transport adapter behind `A2A_ENABLED` flag

```json
{
  "task_id": "P6-4",
  "goal": "Implement RemoteParticipant in src/pipeline/arbitration/a2a/remote-participant.ts that calls a remote agent over <A2A_TRANSPORT> using src/lib/http-client.ts; gate participant construction in src/pipeline/arbitration/index.ts on A2A_ENABLED env flag (default false); load remote participant configs from A2A_PARTICIPANTS env (JSON array of {id,url,capabilities}) at bootstrap.",
  "non_goals": [
    "Do not enable A2A by default — A2A_ENABLED defaults to false and the env must be read exactly once at bootstrap.",
    "Do not introduce mTLS/OAuth — auth is a single shared-secret bearer header `Authorization: Bearer ${A2A_SHARED_SECRET}`.",
    "Do not add a discovery/registry endpoint; participant list comes from env.",
    "Do not allow remote participants to invoke local tools, code execution, or file I/O.",
    "Do not change LocalParticipant or dispatch.ts loop behavior beyond adding a remote branch via the same RoomParticipant interface."
  ],
  "allowed_write_paths": [
    "src/pipeline/arbitration/a2a/remote-participant.ts",
    "src/pipeline/arbitration/a2a/transport.ts",
    "src/pipeline/arbitration/index.ts",
    "src/app/bootstrap.ts"
  ],
  "read_context": [
    "src/pipeline/arbitration/participants.ts",
    "src/pipeline/arbitration/index.ts",
    "src/lib/http-client.ts",
    "src/app/bootstrap.ts",
    "docs/specs/subbrain-main.md:505-518"
  ],
  "risk_tier": "public-api",
  "acceptance": [
    "bunx tsc --noEmit",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-deep-imports.ts",
    "bun test tests/arbitration.test.ts tests/arbitration-abort.test.ts",
    "env A2A_ENABLED=false bun test tests/arbitration.test.ts",
    "rg -n 'A2A_ENABLED' src/pipeline/arbitration/index.ts src/app/bootstrap.ts",
    "rg -n 'fetchJson|fetchStream' src/pipeline/arbitration/a2a/transport.ts",
    "rg -n 'fetch\\(|new Request\\(' src/pipeline/arbitration/a2a/ && exit 1 || true",
    "wc -l src/pipeline/arbitration/a2a/remote-participant.ts src/pipeline/arbitration/a2a/transport.ts | awk '{ if ($1 > 150) exit 1 }'"
  ],
  "diff_budget_loc": 280,
  "file_count_max": 4,
  "rollback": "git revert; A2A_ENABLED defaulting to false means even an un-reverted partial state stays inert.",
  "escalation_triggers": [
    "MANDATORY: if <A2A_TRANSPORT> wire protocol is not fixed in spec at run time, escalate before writing transport.ts.",
    "If shared-secret bearer auth is judged insufficient by review, escalate — do NOT silently add mTLS.",
    "If timeout/abort propagation cannot be implemented over <A2A_TRANSPORT> via AbortSignal, escalate.",
    "If remote participant returns >256 KB content, escalate (need streaming + cap).",
    "If bootstrap.ts exceeds 150 lines after adding A2A env parsing, escalate — it is currently 141 lines with no whitelist entry."
  ],
  "glossary": {
    "<A2A_TRANSPORT>": "TBD — placeholder for chosen wire (Google A2A JSON-RPC+SSE | HTTP+SSE | gRPC). Must be fixed in spec before P6-4 starts.",
    "RemoteParticipant": "RoomParticipant impl with kind='remote'; ask() POSTs ParticipantInput over <A2A_TRANSPORT> and maps the response to ParticipantOutput.",
    "A2A_ENABLED": "Env flag, parsed at bootstrap in src/app/bootstrap.ts; default false. Read once, not per request.",
    "A2A_PARTICIPANTS": "JSON array env var, e.g. `[{\"id\":\"alice\",\"url\":\"https://...\",\"capabilities\":[\"code\"]}]`."
  }
}
```

---

## P6-5 — Tests: local parity + remote smoke + flag toggle

```json
{
  "task_id": "P6-5",
  "goal": "Add tests/a2a-arbitration.test.ts covering: (a) local-only parity vs golden synthesis, (b) RemoteParticipant happy-path with mocked transport returning canned ParticipantOutput, (c) A2A_ENABLED=false produces zero remote participants, (d) RemoteParticipant timeout maps to {content:'',timedOut:true} without throwing.",
  "non_goals": [
    "Do not hit a live remote endpoint in tests; mock src/pipeline/arbitration/a2a/transport.ts at the module boundary.",
    "Do not modify production code; this is a test-only packet.",
    "Do not add live tests (*.live.ts) in this packet.",
    "Do not change existing tests/arbitration.test.ts or tests/arbitration-abort.test.ts."
  ],
  "allowed_write_paths": [
    "tests/a2a-arbitration.test.ts",
    "tests/fixtures/a2a/participant-output.json"
  ],
  "read_context": [
    "tests/arbitration.test.ts",
    "tests/arbitration-abort.test.ts",
    "src/pipeline/arbitration/index.ts",
    "src/pipeline/arbitration/a2a/remote-participant.ts",
    "src/pipeline/arbitration/a2a/transport.ts"
  ],
  "risk_tier": "ordinary",
  "acceptance": [
    "bunx tsc --noEmit",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-deep-imports.ts",
    "bun test tests/a2a-arbitration.test.ts",
    "bun test tests/arbitration.test.ts tests/arbitration-abort.test.ts tests/a2a-arbitration.test.ts",
    "rg -n 'A2A_ENABLED' tests/a2a-arbitration.test.ts",
    "rg -n 'mock.module|spyOn' tests/a2a-arbitration.test.ts"
  ],
  "diff_budget_loc": 200,
  "file_count_max": 2,
  "rollback": "Delete the test file and fixture.",
  "escalation_triggers": [
    "If `bun:test` lacks the mocking primitive needed to stub transport.ts, escalate (do not add a new mocking lib).",
    "If parity assertion (a) fails because LocalParticipant introduced drift, escalate back to P6-2.",
    "If A2A_ENABLED env mutation across tests leaks state between test files, escalate."
  ],
  "glossary": {
    "golden synthesis": "Synthesis string captured from main branch before P6-1..P6-4 land, stored as a fixture; parity test compares string equality.",
    "canned ParticipantOutput": "Static JSON in tests/fixtures/a2a/participant-output.json mirroring the ParticipantOutput shape from P6-1."
  }
}
```

---

## P6-6 — Doc + example config update

```json
{
  "task_id": "P6-6",
  "goal": "Document A2A flag and participant config in CLAUDE.md §Architecture and add example A2A_PARTICIPANTS JSON to .env.example; mark Phase 6 as DONE in docs/specs/subbrain-main.md and strike P6-1..P6-5 from the active task list.",
  "non_goals": [
    "Do not add new architectural prose beyond a single subsection.",
    "Do not introduce real participant URLs or secrets in .env.example.",
    "Do not edit any source code under src/.",
    "Do not change unrelated CLAUDE.md sections."
  ],
  "allowed_write_paths": [
    "CLAUDE.md",
    ".env.example",
    "docs/specs/subbrain-main.md",
    "docs/tasks/agent-teams/05-a2a-arbitration.md"
  ],
  "read_context": [
    "CLAUDE.md",
    ".env.example",
    "docs/specs/subbrain-main.md:505-518",
    "docs/tasks/agent-teams/05-a2a-arbitration.md"
  ],
  "risk_tier": "ordinary",
  "acceptance": [
    "rg -n 'A2A_ENABLED|A2A_PARTICIPANTS|A2A_SHARED_SECRET' .env.example",
    "rg -n '## A2A|RoomParticipant' CLAUDE.md",
    "rg -n 'Phase 6.*DONE|Phase 6 — A2A.*DONE' docs/specs/subbrain-main.md",
    "rg -n 'Status:.*DONE' docs/tasks/agent-teams/05-a2a-arbitration.md",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-deep-imports.ts"
  ],
  "diff_budget_loc": 120,
  "file_count_max": 4,
  "rollback": "git revert; docs-only.",
  "escalation_triggers": [
    "If P6-1..P6-5 are not all merged at run time, escalate — do not mark Phase 6 DONE prematurely.",
    "If CLAUDE.md is over its file cap after edit, escalate."
  ],
  "glossary": {
    "Phase 6 DONE marker": "Inline `Status: DONE (PR #N)` next to Phase 6 heading in spec + this task file."
  }
}
```

---

## Output contract (per packet)

```text
OK <task_id>: <one-line summary>
```

or

```text
FAIL: <task_id>: <category>: <short reason>
```

## Cross-packet pre-flight

Before P6-1 starts, the executor must verify:

1. `git log --oneline | rg -i 'bifrost'` shows Phase 1 merge.
2. `git log --oneline | rg -i 'agent.pool|agent_tasks'` shows Phase 2 merge.
3. `bun test` is green on `main`.

If any check fails — escalate, do not proceed.
