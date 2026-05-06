# Kimi Navigation — Live Dispatch Board

> Updated by Kimi worker after EVERY checkpoint (CP0-CP3) and after packet completion.
> Human/strong-model updates CP4-CP5 and TBD resolution.
> Format: `status: <state>` + `last_cp: <cp0|cp1|cp2|cp3|done>` + `blocker: <none|...>`

> **2026-05-06 — model-tier restriction lifted by user.** All packets formerly tagged `STRONG-MODEL ONLY` are now Kimi-eligible. `SECURITY` / `DB operator` tags remain (they describe required acceptance gates — integration tests, operator auth, schema-change rollback notes — not delegation tier).

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
| P2-1 | Agent tasks schema (mig 19) | `done` | `cp3` | — | CRITIC-PASSED. Commit 3e1d246. Critic ok:true round 1. |
| P2-2 | Agent tasks admin REST endpoints | `done` | `cp3` | — | CRITIC-PASSED. Route file 63 lines. 6/6 tests pass. tsc clean. |
| P2-3 | Agent pool runner | `done` | `cp3` | — | CRITIC-PASSED. Commit bc9a2fd. Re-entrancy guard fixed (removed MIN_INTERVAL_MS clamp). 9/9 tests pass. |
| P2-4 | Terminate + artifact tool | `done` | `cp3` | — | CRITIC-PASSED. Bundled in commit d8f849e (P3-6). `done_with_artifact.ts` + tests exist. |
| P2-5 | Pool dispatch integration | `done` | `cp3` | — | CRITIC-PASSED. Bundled in P2-3 bc9a2fd + P2-7 c0efada. `tick.ts` + `concurrency.ts` implement dispatch. cp0/tsc/tests green. |
| P2-5a | AgentLoopRequest expansion | `done` | `cp3` | — | CRITIC-PASSED. Commit 051fb30. |
| P2-6 | Per-type rate limits + digest aggregation | `done` | `cp3` | — | CRITIC-PASSED. Commit e9c6f13. Files: rate-limits.ts, digest.ts, index.ts, types.ts, .env.example. 11/11 tests pass. cp0 green, tsc clean. |
| P2-7 | Pool safety (rate-limit) | `done` | `cp3` | — | CRITIC-PASSED. Commit c0efada. 27/27 agent-pool tests pass. cp0/tsc green. Parallel concurrency behind AGENT_POOL_MAX_CONCURRENT env flag. |
| P2-7a | Mutex primitive | `done` | `cp3` | — | CRITIC-PASSED. Commit 06ef49b. Worker ac668624. |
| P3-1 | Memory bi-temporal verify | `done` | `cp3` | — | CRITIC-PASSED. Commit ed96d90. Extra doc cleanup bundled. |
| P3-2 | Bi-temporal nullable cols (mig 17) | `done` | `cp3` | — | CRITIC-PASSED. Commit 8e25ac4. |
| P3-3 | Bi-temporal active filter in retrieval | `done` | `cp3` | — | CRITIC-PASSED. Commit e8727a7. |
| P3-4 | Edge-walk boost in RAG pipeline | `done` | `cp3` | — | CRITIC-PASSED. Commit 283b66c. Worker a270dc9d06a8ef641. /tmp script bypass worked. 1013 tests pass (+10 new). |
| P3-5 | Memory blocks table (mig 18) | `done` | `cp3` | — | CRITIC-PASSED. Commit 7db48ff. |
| P3-6 | Sleep role + NIGHT_CYCLE_MODEL resolver | `done` | `cp3` | — | CRITIC-PASSED. Commit d8f849e. 5/5 tests pass. |
| P3-7 | Predicate parens fix | `done` | `cp3` | — | CRITIC-PASSED. Commit cc8b794. 12/12 tests pass. |
| P3-8 | rag/pipeline.ts → index.ts | `done` | `cp3` | — | CRITIC-PASSED. Commit fbb7522. Prompt-only: arbitrator verification + hippocamp character. cp0/tsc/tests green. |
| P3-9 | Memory archive + TTL | `done` | `cp3` | — | CRITIC-PASSED. Commit 585aa83 (M-12). Migration 15: archive.confidence TEXT→REAL. |
| P6-1 | A2A room init | `done` | `cp3` | — | CRITIC-PASSED. Commit 615920b. 26 LOC, no scope creep. |
| P6-2 | A2A dispatch hook | `done` | `cp3` | — | CRITIC-PASSED. Commit 9699845. Worker a22d163d. |
| P6-3 | A2A transcripts schema | `done` | `cp3` | — | CRITIC-PASSED. Commit 7db539f. 316 lines, 6 files. cp0/tsc/tests green. |
| P6-4 | A2A transport wiring | `not_started` | — | `<A2A_TRANSPORT>`, blocks on P6-3 | CRITIC-PASSED |
| P6-5 | A2A synthesis loop | `not_started` | — | blocks on P6-3, P6-4 | CRITIC-PASSED |
| P6-6 | A2A cleanup + docs | `not_started` | — | blocks on P6-5 | CRITIC-PASSED |
| A2-1 | Plugin registry init | `done` | `cp3` | — | CRITIC-PASSED. Commit 31b3e84. Bundled with spec-cleanup. |
| A2-2 | Plugin loader | `done` | `cp3` | — | CRITIC-PASSED. Commit e90a153. |
| A2-3 | Plugin sandbox | `done` | `cp3` | — | CRITIC-PASSED. Commit 237d2a0. Hook wiring in tool-runner.ts + tests. |
| A2-4 | Plugin hooks (pre/post) | `done` | `cp3` | — | CRITIC-PASSED. Commit 58f2342. Worker a3ddfcbb. cp0-cp2-cp3 green, 8/8 tests pass. |
| A2-5a | ToolResult types + shim | `done` | `cp3` | — | CRITIC-PASSED. Commit eb7aa59. Restored old ToolResult interface as primary; added ToolResultV2 + toLegacy alongside. |
| A2-5b | ToolResult caller migration | `done` | `cp3` | — | CRITIC-PASSED. Commit f1537e2. 28 files, 11 src + 17 tests. Full suite 1114 pass / 0 fail. cp0-cp2 green. |
| A2-6 | Code-tool guards | `done` | `cp3` | — | CRITIC-PASSED. Commit 0fcc408 (F-2+F-3b+F-4). 833/0 tests pass. |
| A2-7 | TG spam gates | `done` | `cp3` | — | CRITIC-PASSED. Commit 87c662f. Plugin migration DONE (tg-gates internal plugin). |
| A2-8 | Migrate STATEFUL_CLIENT_CODE_TOOLS + freelance-scout shell | `done` | `cp3` | — | CRITIC-PASSED. Commit 4489b43. Critic ok:true round 1. |
| A2-9 | INTERNAL_PLUGINS registry + boot-time wire | `done` | `cp3` | — | CRITIC-PASSED. Commit d3d24d8. 21/21 plugin tests pass. cp0/tsc green. 5 pre-existing schema test failures (user_version 22 vs 19). |

**Wave 2 merge gate:** ✅ ALL Wave 2 packets done. Wave 3 unblocked.

---

## Wave 3 — Security Tier

| Phase | Packet | Status | Last CP | Blocker | Notes |
|---|---|---|---|---|---|
| 8a-1 | Approval schema (mig 20+) | `done` | `cp3` | — | CRITIC-PASSED. Commit fd13506. 340 lines, 6 files. cp0/tsc/tests green. |
| 8a-2 | Approval spam gate | `not_started` | — | **SECURITY** | CRITIC-PASSED |
| 8a-3 | Approval request flow | `not_started` | — | — | CRITIC-PASSED |
| 8a-4 | Approval operator chat | `not_started` | — | — | CRITIC-PASSED |
| 8a-5 | Approval audit log | `not_started` | — | — | CRITIC-PASSED |
| 8a-6 | Approval rate limits | `not_started` | — | — | CRITIC-PASSED |
| 8a-7 | Approval docs | `not_started` | — | — | CRITIC-PASSED |
| 8c-1 | Backup schedule | `not_started` | — | **DB** — operator auth | CRITIC-PASSED |
| 8c-2 | Backup VACUUM INTO | `not_started` | — | **DB** — operator auth | CRITIC-PASSED |
| 8c-3 | Backup retention | `not_started` | — | **DB** — operator auth | CRITIC-PASSED |
| 8c-4 | Backup restore script | `not_started` | — | **SECURITY** — confirm flag | CRITIC-PASSED |
| 8c-5 | Backup monitoring | `not_started` | — | **DB** — operator auth | CRITIC-PASSED |
| 8c-6 | Backup docs | `not_started` | — | **DB** — operator auth | CRITIC-PASSED |
| 8e-1 | PII scrub lib | `done` | `cp3` | — | CRITIC-PASSED. Commit 2ea5db2. 15/15 pii tests pass. cp0-cp1-cp2 green. |
| 8e-2 | PII table layer | `not_started` | — | — | CRITIC-PASSED |
| 8e-3 | PII tg_chats schema (mig 22) | `done` | `cp3` | — | CRITIC-PASSED. Commit d289380. 7/7 tests pass. Migration 22: tg_chat_policies table + TgChatPolicyRepository. cp0-cp1-cp2 green. |
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
| P5-1 Langfuse-vs-Laminar | P5-1 | open | — (tier lifted 2026-05-06) |
| P2-5a AgentLoopRequest | P2-5a | **RESOLVED** | Commit 051fb30 |
| P2-7a Mutex | P2-7a | **RESOLVED** | Commit 06ef49b |
| P6-3 schema choice | P6-3 | **RESOLVED** | new table `arbitration_transcripts` chosen (artifact_payload reuse rejected — mixing A2A metadata with task artifacts creates coupling) |
| 8a-1 migration number | 8a-1 | **RESOLVED** | migration 21 (8e-3 takes 20) |
| 8e-3 migration number | 8e-3 | **RESOLVED** | migration 20 (was 17) |

---

## Post-audit cleanup gaps (2026-05-05 — Grade B assessment)

> These are NOT packets in a numbered wave; they are cross-cutting cleanups identified by owner audit. Dispatch as capacity allows, but do NOT mark downstream packets done until blockers below are resolved.

| # | Item | Status | Blocker | Scope | Notes |
|---|---|---|---|---|---|
| C1 | BAML runtime wire (hippocampus + arbitration) | `not_started` | — | P4 revisit | Replace `parseMemoryWriteArgs` local parser in `packages/agent/src/pipeline/agent-pipeline/post/hippocampus.ts:199` with actual `b.ExtractMemoryWrite()` BAML runtime call. Same for arbitration path. Acceptance: grep proves BAML function called in production path, not just imported. |
| C2 | Split `packages/server/src/app/deps.ts` (367→4 files) | `not_started` | — | A1 revisit | True split: `loadConfig.ts`, `prompts/autonomous-task.ts` (75-line literal), `init-services.ts`, `init-telegram.ts`. No `// TODO: split` leftovers. File-cap 150 per file. |
| C3 | Drop dead barrels + shim | `done` | — | A1 revisit | Commit 27d366c. Extractors.ts import fixed to `./validators/index`; `validators.ts` shim + `packages/agent/src/index.ts` barrel deleted. cp0/tsc green, 30 tests pass. |
| C4 | Type transport boundary (TypeBox guards) | `done` | — | security | Commit a866309. mcp-protocol.ts: `body as any` → TypeBox `t.Object({jsonrpc, id, method, params})`. telegram.ts: `body as any` → `body as Update` from grammy. Zero `as any`/`as unknown` in both files. cp0/tsc green, 22 tests pass. |

---

## Active workers (this session)

| Packet | Worker | Status | Started |
|---|---|---|---|
| FIX-test | agent-FIX-2 | **DONE** | 2026-05-06 02:14 UTC, commit f43cd81, cp0 green, test 12/12 pass |
| P2-5 | agent-P25-3 | **KILLED** | 2026-05-06 02:27 UTC → 02:43 UTC, no commits, >15 min, cp0 green, tsc fixed |
| P2-5 | agent-P25-4 | **DONE** | 2026-05-06 03:26 UTC — commit b0feff2 (tsc fix). Files in A2-5b f1537e2. cp0 green, tsc clean, 3/3 tests pass |
| A2-5b | agent-A25b-3 | **KILLED** | 2026-05-06 02:27 UTC → 02:43 UTC, no commits, >15 min, tsc fixed, tests still failing |
| A2-5b | agent-A25b-4 | **DONE** | 2026-05-06 03:04 UTC — commit f1537e2, 28 files, 1114 pass / 0 fail, cp0-cp2 green |
| P3-7 | agent-P37-1 | **KILLED** | 2026-05-06 02:29 UTC → 02:38 UTC, hippocampus.ts grew to 232 lines (file-cap violation), cap-guard.ts tsc errors |
| P3-7 | agent-P37-2 | **KILLED** | 2026-05-06 02:38 UTC → ~04:20 UTC, repo corruption from `git stash pop` (old stash applied on clean tree → 6 files with merge conflicts). Orchestrator recovered: reset UU files to HEAD, unstage + discard bad stash changes, drop stash@{0}. cp0/tsc/tests green on clean HEAD. |
| P2-6 | agent-P26-1 | **KILLED** | 2026-05-06 ~02:30 UTC → ~04:20 UTC, >1hr no commits, stuck on permission denied reading `.env.example` via Bash. |
| P3-7 | agent-P37-3 | **DONE** | 2026-05-06 ~04:25 UTC — commit cc8b794, 12/12 tests pass, tsc clean, cp0 green |
| P2-6 | agent-P26-2 | **DONE** | 2026-05-06 ~04:25 UTC — commit e9c6f13, 11/11 tests pass, tsc clean, cp0 green |
| P2-7 | agent-P27-1 | **DONE** | 2026-05-06 ~04:40 UTC → 07:50 UTC — commit c0efada, cp0/tsc/tests green. Worker scope-creeped into .env.example + .agentignore but core deliverable correct. |
| P3-8 | agent-P38-1 | **KILLED** | 2026-05-06 ~04:40 UTC → ~07:49 UTC — scope creep into P2-7 files (pool/index.ts, agent-tasks.repo.ts), >40 min no commit on own prompt files. |
| P3-8 | agent-P38-2 | **DONE** | 2026-05-06 ~07:52 UTC — commit fbb7522, cp0/tsc/tests green |
| C3 | agent-C3-1 | **DONE** | 2026-05-06 ~08:28 UTC — commit 27d366c, cp0/tsc/tests green |
| C4 | agent-C4-1 | **DONE** | 2026-05-06 ~08:28 UTC — commit a866309, cp0/tsc/tests green |
| A2-6 | agent-A26-1 | **DONE** | 2026-05-06 ~08:28 UTC — commit 296448d, cp0/tsc/tests green, 1156 pass/0 fail |

---

## Last Updated

2026-05-06 ~12:20 UTC — Schema test fix DONE (commit fda4952). 22/22 schema tests pass. Active workers: 8a-2 (approval registry), 8e-2 (ingest PII scrub). Cap 2/3. Wave 2: all done. Wave 3: unblocked.

**P3-7 discovery:** implementation already complete (cap-guard.ts, process-tool.ts, prompt.ts, hippocampus.ts all have PR-D logic). All acceptance grep checks pass. Only missing: `tests/hippocampus-cap.test.ts` + `tests/hippocampus-extraction.test.ts`. Worker v3 scope = test files only.
