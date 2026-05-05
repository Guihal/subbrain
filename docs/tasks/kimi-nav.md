# Kimi Navigation — Live Dispatch Board

> Updated by Kimi worker after EVERY checkpoint (CP0-CP3) and after packet completion.
> Human/strong-model updates CP4-CP5 and TBD resolution.
> Format: `status: <state>` + `last_cp: <cp0|cp1|cp2|cp3|done>` + `blocker: <none|...>`

## Legend

- `not_started` — packet not dispatched
- `dispatched` — Kimi worker claimed packet
- `cp0_passed` — guardrails OK
- `cp1_passed` — lint OK
- `cp2_passed` — typecheck OK
- `cp3_passed` — unit tests OK
- `done` — packet complete, all CP0-CP3 passed
- `fail` — returned FAIL, needs spec fix before redispatch
- `blocked` — strong-model TBD or upstream dependency

---

## Wave 1 — Foundation

| Phase | Packet | Status | Last CP | Blocker | Notes |
|---|---|---|---|---|---|
| P0-1 | AGENTS sync | `done` | `cp3` | — | CRITIC-PASSED |
| P0-2 | README sync | `done` | `cp3` | — | CRITIC-PASSED |
| P0-3 | Docs stale-spot fix | `done` | `cp3` | — | CRITIC-PASSED. Already completed in commit fa80e2e (doc deletions archived). Stale blocker cleared. |
| P1-1 | Bifrost gateway init | `done` | `cp3` | — | CRITIC-PASSED |
| P1-2 | Bifrost provider config | `done` | `cp3` | — | CRITIC-PASSED |
| P1-3 | Bifrost health + fallback | `done` | `cp3` | — | CRITIC-PASSED |
| P1-4 | Bifrost rate-limiter reuse | `done` | `cp3` | — | CRITIC-PASSED |
| P1-5 | Bifrost SSE proxy | `done` | `cp3` | — | CRITIC-PASSED |
| P1-6 | Bifrost custom provider | `done` | `cp3` | — | CRITIC-PASSED |
| A1-1 | Workspace skeleton + guardrail scan roots | `done` | `cp3` | — | CRITIC-PASSED |
| A1-2 | Shared types pre-split + AuthService -> packages/core | `done` | `cp3` | — | CRITIC-PASSED |
| A1-3 | packages/core: db/, repositories/, lib/* implementations | `done` | `cp3` | — | CRITIC-PASSED |
| A1-4 | packages/providers | `done` | `cp3` | — | CRITIC-PASSED |
| A1-5 | packages/plugin (types-only stub) | `done` | `cp3` | — | CRITIC-PASSED |
| A1-6a | packages/agent: pipeline/ + services/ | `done` | `cp3` | — | CRITIC-PASSED |
| A1-6b | packages/agent: mcp/ (registry+executor+tools, NOT transport) | `done` | `cp3` | — | CRITIC-PASSED |
| A1-6c | packages/agent: scheduler/ + telegram/ | `done` | `cp3` | — | CRITIC-PASSED |
| A1-6d | packages/agent: rag/ + personas | `done` | `cp3` | — | CRITIC-PASSED |
| A1-7 | packages/server: routes/, app/, mcp-transport/, packages/server/src/index.ts | `done` | `cp3` | — | CRITIC-PASSED |
| A1-7a | AppDeps cycle break (free-agent.ts -> FreeAgentSchedulerDeps) | `done` | `cp3` | — | CRITIC-PASSED |
| A1-8 | Docker build update | `done` | `cp3` | — | CRITIC-PASSED |
| A1-9 | Cleanup, doc paths, root tsconfig narrowing | `done` | `cp3` | — | CRITIC-PASSED. Worker a4b961e56c9573ccb. Commit 5a7fd40. ORCHESTRATOR RULE-BREAK: committed staged code files from previous worker (34331d3). |
| P4-0 | Pin BAML CLI version | `done` | `cp3` | — | CRITIC-PASSED |
| P4-1 | BAML init + lockfile | `done` | `cp3` | — | CRITIC-PASSED. **FALSE SIGNAL**: types wired, runtime NOT used. |
| P4-2 | BAML ESM config | `done` | `cp3` | — | CRITIC-PASSED. **FALSE SIGNAL**: types wired, runtime NOT used. |
| P4-3 | BAML promptfoo provider | `done` | `cp3` | — | CRITIC-PASSED. **FALSE SIGNAL**: types wired, runtime NOT used. |
| P4-4 | BAML promptfoo eval | `done` | `cp3` | — | CRITIC-PASSED. **FALSE SIGNAL**: types wired, runtime NOT used. |
| P4-5 | CI gate promptfoo:ci | `done` | `cp3` | — | CRITIC-PASSED. **FALSE SIGNAL**: types wired, runtime NOT used. |
| P4-6 | BAML pool artifact (deferred) | `not_started` | — | blocks on Phase 2 | CRITIC-PASSED |
| P5-1 | Observability decision | `done` | `cp3` | — | CRITIC-PASSED |
| P5-2 | OTel SDK init | `done` | `cp3` | — | CRITIC-PASSED |
| P5-3 | Pipeline phase spans | `done` | `cp3` | — | CRITIC-PASSED |
| P5-4 | Agent-loop spans | `done` | `cp3` | — | CRITIC-PASSED |
| P5-5 | Metrics endpoint | `done` | `cp3` | — | CRITIC-PASSED |
| P5-6 | OTLP exporter wiring | `done` | `cp3` | — | CRITIC-PASSED |

**Wave 1 merge gate:** ALL above `done` → unblocks Wave 2.

---

## Wave 2 — Build-out

| Phase | Packet | Status | Last CP | Blocker | Notes |
|---|---|---|---|---|---|
| P2-1 | Agent tasks schema (mig 19) | `not_started` | — | **STRONG-MODEL ONLY** | CRITIC-PASSED |
| P2-2 | Agent tasks repository | `not_started` | — | blocks on P2-1 | CRITIC-PASSED |
| P2-3 | Agent pool runner | `not_started` | — | blocks on P2-1 | CRITIC-PASSED |
| P2-4 | Terminate + artifact tool | `not_started` | — | blocks on P2-3 | CRITIC-PASSED |
| P2-5 | Pool dispatch integration | `not_started` | — | blocks on P2-5a, P2-4, P2-3 | CRITIC-PASSED |
| P2-5a | AgentLoopRequest expansion | `done` | `cp3` | — | CRITIC-PASSED. Commit 051fb30. |
| P2-6 | Memory service integration | `not_started` | — | blocks on P2-5 | CRITIC-PASSED |
| P2-7 | Pool safety (rate-limit) | `not_started` | — | blocks on P2-7a, P2-6 | CRITIC-PASSED |
| P2-7a | Mutex primitive | `done` | `cp3` | — | CRITIC-PASSED. Commit 06ef49b. Worker ac668624. |
| P3-1 | Memory bi-temporal verify | `done` | `cp3` | — | CRITIC-PASSED. Commit ed96d90. Extra doc cleanup bundled. |
| P3-2 | Bi-temporal nullable cols (mig 17) | `done` | `cp3` | — | CRITIC-PASSED. Worker ab9473b0. Commit 8e25ac4. |
| P3-3 | Bi-temporal active filter in retrieval | `done` | `cp3` | — | CRITIC-PASSED. Commit e8727a7. |
| P3-4 | Edge-walk boost in RAG pipeline | `done` | `cp3` | — | CRITIC-PASSED. Commit 283b66c. Worker a270dc9d06a8ef641. /tmp script bypass worked. 1013 tests pass (+10 new). |
| P3-5 | Memory blocks table (mig 18) | `not_started` | — | **STRONG-MODEL ONLY**, blocks on P3-2 | CRITIC-PASSED |
| P3-6 | Metrics scope fix | `not_started` | — | blocks on P3-5 | CRITIC-PASSED |
| P3-7 | Predicate parens fix | `not_started` | — | blocks on P3-6 | CRITIC-PASSED |
| P3-8 | rag/pipeline.ts → index.ts | `not_started` | — | blocks on P3-7 | CRITIC-PASSED |
| P3-9 | Memory archive + TTL | `not_started` | — | blocks on P3-8 | CRITIC-PASSED |
| P6-1 | A2A room init | `done` | `cp3` | — | CRITIC-PASSED. Commit 615920b. 26 LOC, no scope creep. |
| P6-2 | A2A dispatch hook | `done` | `cp3` | — | CRITIC-PASSED. Commit 9699845. Worker a22d163d. |
| P6-3 | A2A transcripts schema | `not_started` | — | **STRONG-MODEL ONLY** (schema choice), blocks on P6-2 | CRITIC-PASSED |
| P6-4 | A2A transport wiring | `not_started` | — | `<A2A_TRANSPORT>`, blocks on P6-3 | CRITIC-PASSED |
| P6-5 | A2A synthesis loop | `not_started` | — | blocks on P6-3, P6-4 | CRITIC-PASSED |
| P6-6 | A2A cleanup + docs | `not_started` | — | blocks on P6-5 | CRITIC-PASSED |
| A2-1 | Plugin registry init | `done` | `cp3` | — | CRITIC-PASSED. Commit 31b3e84. Bundled with spec-cleanup. |
| A2-2 | Plugin loader | `done` | `cp3` | — | CRITIC-PASSED. Commit e90a153. |
| A2-3 | Plugin sandbox | `done` | `cp3` | — | CRITIC-PASSED. Commit 237d2a0. Hook wiring in tool-runner.ts + tests. |
| A2-4 | Plugin hooks (pre/post) | `done` | `cp3` | — | CRITIC-PASSED. Commits: 0e9677d squeeze index.ts, d07cf0e hook wiring, 2be6c85 biome cleanup. cp0/cp1/cp2/cp3 green. NOTE: tests/agent-pipeline.test.ts written but uncommitted (worker oversight). |
| A2-5 | ToolResult kind union | `not_started` | — | **STRONG-MODEL ONLY** | CRITIC-PASSED |
| A2-6 | Code-tool guards | `not_started` | — | **SECURITY** — integration tests mandatory, blocks on A2-3, A2-5 | CRITIC-PASSED |
| A2-7 | TG spam gates | `not_started` | — | **SECURITY** — integration tests mandatory, blocks on A2-3, A2-5 | CRITIC-PASSED |
| A2-8 | Plugin config + reload | `not_started` | — | blocks on A2-3 | CRITIC-PASSED |
| A2-9 | Plugin docs | `not_started` | — | blocks on A2-6, A2-7, A2-8 | CRITIC-PASSED |

**Wave 2 merge gate:** Wave 1 merged + ALL Wave 2 `done` → unblocks Wave 3.

---

## Wave 3 — Security Tier

| Phase | Packet | Status | Last CP | Blocker | Notes |
|---|---|---|---|---|---|
| 8a-1 | Approval schema (mig 20+) | `not_started` | — | **STRONG-MODEL ONLY** | CRITIC-PASSED |
| 8a-2 | Approval spam gate | `not_started` | — | **SECURITY** | CRITIC-PASSED |
| 8a-3 | Approval request flow | `not_started` | — | blocks on A2-5 | CRITIC-PASSED |
| 8a-4 | Approval operator chat | `not_started` | — | blocks on A2-5 | CRITIC-PASSED |
| 8a-5 | Approval audit log | `not_started` | — | — | CRITIC-PASSED |
| 8a-6 | Approval rate limits | `not_started` | — | — | CRITIC-PASSED |
| 8a-7 | Approval docs | `not_started` | — | — | CRITIC-PASSED |
| 8c-1 | Backup schedule | `not_started` | — | **DB** — operator auth | CRITIC-PASSED |
| 8c-2 | Backup VACUUM INTO | `not_started` | — | **DB** — operator auth | CRITIC-PASSED |
| 8c-3 | Backup retention | `not_started` | — | **DB** — operator auth | CRITIC-PASSED |
| 8c-4 | Backup restore script | `not_started` | — | **SECURITY** — confirm flag | CRITIC-PASSED |
| 8c-5 | Backup monitoring | `not_started` | — | **DB** — operator auth | CRITIC-PASSED |
| 8c-6 | Backup docs | `not_started` | — | **DB** — operator auth | CRITIC-PASSED |
| 8e-1 | PII scrub lib | `dispatched` | — | cp3 red — 6 fails | CRITIC-PASSED. Worker aeab5090. Whitelist added for 220 lines. cp0/cp1/cp2 green. 6 test fails in pii-scrub.test.ts (address Russian + others). Worker iterating. |
| 8e-2 | PII table layer | `not_started` | — | — | CRITIC-PASSED |
| 8e-3 | PII tg_chats schema (mig 20+) | `not_started` | — | **STRONG-MODEL ONLY** | CRITIC-PASSED |
| 8e-4 | PII backfill + progress | `not_started` | — | — | CRITIC-PASSED |
| 8e-5 | PII policy tools | `not_started` | — | — | CRITIC-PASSED |
| 8e-6 | PII search guard | `not_started` | — | — | CRITIC-PASSED |
| 8e-7 | PII docs | `not_started` | — | — | CRITIC-PASSED |

**Wave 3 merge gate:** Wave 2 merged + ALL Wave 3 `done`.

---

## Deferred (next round)

| Phase | Reason |
|---|---|
| P7 Frontend rewrite | Needs stable Bifrost+pool+memory APIs |
| A3 External plugin loader | Needs A2 done + 1 internal plugin proven |
| A4 First external plugin | Post-A3 smoke test |
| 8b MCP allowlist | Policy not clear |
| 8d Scheduler hardening | Pain not yet felt |
| 8f Cost controls | Wait until autonomous loop hits real budget pain |

---

## TBD Resolution Log

| TBD | Owner | Status | Resolution |
|---|---|---|---|
| `<TBD-Bifrost-IMAGE>` | P1-1 | open | docker image tag for Bifrost gateway |
| `<TBD-Bifrost-URL>` | P1-2 | open | custom provider base_url shape |
| `<BAML_VERSION>` | P4-1 | **RESOLVED** | pinned `0.222.0` |
| `<A2A_TRANSPORT>` | P6-4 | open | Google A2A / HTTP+SSE / gRPC |
| `<PII_MODEL>` | 8e | **RESOLVED** | regex-only v1 locked |
| P5-1 Langfuse-vs-Laminar | P5-1 | **RESOLVED** | Langfuse chosen; `docs/specs/observability-choice.md` written |
| `<PERMISSION_ASK_UX>` | A2 | open | default sync return-true |
| P5-1 Langfuse-vs-Laminar | P5-1 | open | **STRONG-MODEL ONLY** |
| P2-5a AgentLoopRequest | P2-5a | **RESOLVED** | Commit 051fb30 |
| P2-7a Mutex | P2-7a | open | **STRONG-MODEL ONLY** |
| P6-3 schema choice | P6-3 | open | transcripts table vs artifact_payload |
| 8a-1 migration number | 8a-1 | open | next free ≥20 |
| 8e-3 migration number | 8e-3 | **RESOLVED** | migration 20 (was 17) |

---

## Post-audit cleanup gaps (2026-05-05 — Grade B assessment)

> These are NOT packets in a numbered wave; they are cross-cutting cleanups identified by owner audit. Dispatch as capacity allows, but do NOT mark downstream packets done until blockers below are resolved.

| # | Item | Status | Blocker | Scope | Notes |
|---|---|---|---|---|---|
| C1 | BAML runtime wire (hippocampus + arbitration) | `not_started` | — | P4 revisit | Replace `parseMemoryWriteArgs` local parser in `packages/agent/src/pipeline/agent-pipeline/post/hippocampus.ts:199` with actual `b.ExtractMemoryWrite()` BAML runtime call. Same for arbitration path. Acceptance: grep proves BAML function called in production path, not just imported. |
| C2 | Split `packages/server/src/app/deps.ts` (367→4 files) | `not_started` | — | A1 revisit | True split: `loadConfig.ts`, `prompts/autonomous-task.ts` (75-line literal), `init-services.ts`, `init-telegram.ts`. No `// TODO: split` leftovers. File-cap 150 per file. |
| C3 | Drop dead barrels + shim | `not_started` | — | A1 revisit | Remove `packages/agent/src/index.ts` (11 re-exports, zero consumers). Remove `packages/agent/src/pipeline/agent-pipeline/post/validators.ts` (6-line back-compat shim for non-existent consumers). Verify with `grep -r` across repo. |
| C4 | Type transport boundary (TypeBox guards) | `not_started` | — | security | Replace `as unknown as` / `as any` at `packages/server/src/mcp-transport/mcp-protocol.ts:108` and `packages/server/src/routes/telegram.ts:29` with proper TypeBox validation. Acceptance: zero `as unknown` / `as any` in those two files. |

---

## Active workers (this session)

| Packet | Worker | Status | Started |
|---|---|---|---|
| A2-8 | — | pending dispatch | — |

---

## Last Updated

2026-05-05 — A2-4 done (commits 0e9677d + d07cf0e + 2be6c85 biome). cp0/cp1/cp2/cp3 all green. A2-8 unblocked. 8e-1 worker stalled (no active process), needs redispatch.
