# Test Audit — Chunk 1 (a-h)

Date: 2026-05-07
Files audited: 60

## Summary
- A (keep): 49
- B (delete): 4
- C (rewrite): 7

## Per-file table

| File | Category | `as any` | `!` | Tests Real Flow? | Rationale (≤120ch) | Suggested Action |
|---|---|---|---|---|---|---|
| agent-loop-dispatch.test.ts | A | 0 | 0 | yes | pure unit — `normalizeToolCalls` flavor parity (OpenAI/Anthropic). No mocks needed. | keep |
| agent-loop-hooks.test.ts | A | 0 | 0 | yes | exercises real `executeAgentTool` + `HooksDispatcher` end-to-end (legacy result shape). | keep |
| agent-loop-request-surface.test.ts | C | 5 | 0 | partial | `as any` on tools/deps, hand-rolled stubs for memory/rag/router; covers init+executeStep surface. | rewrite using shared test fixtures |
| agent-loop-step.test.ts | C | 5 | 0 | partial | rich behavior (tool_calls/done/empty/error) but `as any` everywhere on deps; brittle stubs. | rewrite with typed test doubles |
| agent-pipeline.test.ts | A | 2 | 0 | yes | runPre/runMain hooks wiring + `AgentPipeline.execute` real path. Few `as any` localized. | keep |
| agent-pool-claim-race.test.ts | A | 0 | 0 | yes | real DB; 50-iter atomic-claim race; high-signal regression catcher. | keep |
| agent-pool-concurrency.test.ts | A | 0 | 0 | yes | real DB + real `runTick` + `RunnerSlots`; verifies parallelism + per-type slots + zombie guard. | keep |
| agent-pool-engine.test.ts | A | 0 | 0 | yes | real DB; covers complete/noop/failed + zombie + re-entrancy. | keep |
| agent-pool-rate-limits.test.ts | A | 0 | 0 | yes | pure unit on `RateLimiter` — boundary timing per type. | keep |
| agent-pool-runner-free.test.ts | A | 0 | 0 | yes | real `AgentLoop` + DB + stub router; token-budget abort regression + source-grep. | keep |
| agent-service.test.ts | A | 0 | 0 | yes | unit on `AgentService` defaults forwarding to AgentLoop; mocks return-value verifications. | keep |
| agent-tasks-repo.test.ts | A | 0 | 0 | yes | real DB CRUD on `agentTasksRepo`. | keep |
| agent-tasks-routes.test.ts | A | 0 | 0 | yes | real Elysia + real DB; HTTP envelope verified. | keep |
| api-envelope.test.ts | A | 0 | 0 | yes | pure unit on `paginate` clamps + offset/page math. | keep |
| app-bootstrap.test.ts | A | 10 | 0 | yes | smoke: `createApp` builds Elysia, /health=200. `as any` on AppDeps stubs is intentional. | keep |
| approval-audit.test.ts | A | 0 | 0 | yes | real `:memory:` DB + real callbacks + sweeper logging audit-trail rows. | keep |
| approval-bot.test.ts | A | 0 | 1 | yes | exercises real `registerApprovalCallbacks` against real ApprovalRepo; mocks only Bot SDK. | keep |
| approval-flow.test.ts | A | 0 | 0 | yes | full integration: gate plugin + dispatcher + DB; covers approve/deny/expiry/unavailable. | keep |
| approval-registry.test.ts | A | 0 | 0 | yes | pure unit on `requiresApproval` / `resolveOperatorChat` / `canonicalizeArgs`. | keep |
| approval-schema.test.ts | A | 0 | 0 | yes | real DB; migration + uniqueness + status transitions; idempotency. | keep |
| approval-sweeper.test.ts | A | 0 | 0 | yes | real DB; TTL boundary + idempotency + ApprovalSweeper start/stop. | keep |
| arbitration-abort.test.ts | A | 0 | 0 | yes | abort propagation through `ArbitrationRoom`; signal observed by mock router. | keep |
| arbitration.test.ts | C | 5 | 0 | partial | `console.assert` script-style (anti-pattern per CLAUDE.md §12); `as any` on router; uses `process.env` mutation + dynamic re-import. | rewrite with `bun:test` describe/test/expect |
| arbitration-transcript.test.ts | A | 0 | 0 | yes | real DB CRUD on transcript repo + indexes + migration idempotency. | keep |
| auth-coverage.test.ts | A | 9 | 0 | yes | live-listen Elysia from `createApp`; covers every gated/public endpoint. `as any` on dep stubs only. | keep |
| auth-service.test.ts | A | 0 | 0 | yes | pure unit on `AuthService.validateBearer` truth table + timing-safety smoke. | keep |
| auth.test.ts | A | 0 | 0 | yes | real Elysia listen + `authMiddleware`; HTTP 401/200 contract. | keep |
| backup-integration.test.ts | A | 0 | 0 | yes | real backup + real CLI subprocess via `Bun.spawn`; refuse/confirm/schema-mismatch paths. | keep |
| backup.test.ts | A | 0 | 0 | yes | real `MemoryDB` + `runBackup`; FTS5 + sqlite-vec round-trip on backup file. | keep |
| baml-esm-smoke.test.ts | A | 0 | 0 | yes | tiny smoke ensuring generated baml client is importable; cheap regression catcher. | keep |
| bifrost-auth-errors.test.ts | A | 0 | 0 | yes | real Bun.serve fake + real BifrostProvider + ModelRouter; 401/403/429/502 → backends untouched. | keep |
| bifrost-cancel.test.ts | A | 0 | 0 | yes | real upstream stream + abort mid-flight; verifies error+[DONE] emission. | keep |
| bifrost-config-parity.test.ts | A | 0 | 0 | yes | reads real `bifrost/config.json` vs `MODEL_MAP`; catches config drift. | keep |
| bifrost-fallback.test.ts | A | 0 | 0 | yes | flag-on path: bifrost error must not fall back to backends. | keep |
| bifrost-provider.test.ts | A | 0 | 0 | yes | real Bun.serve + provider; payload, errors, redaction, abort, embed/rerank refusal. | keep |
| bifrost-stream.test.ts | A | 0 | 0 | yes | real SSE proxy byte-for-byte + 5xx handling + pre-flight abort. | keep |
| browser-smoke.ts | B | 0 | 0 | no | not a `*.test.ts` — script invoked manually; no `bun:test` runner integration. | delete or rename to `*.live.ts` |
| chat-continuity.test.ts | A | 1 | 0 | yes | real Elysia + real `MemoryDB` + chatRoute; verifies hydration logic on x-chat-id. | keep |
| chat-direct-mode.test.ts | A | 2 | 0 | yes | real Elysia + chatRoute; per-provider overload routing decision. | keep |
| chat-service.test.ts | A | 2 | 0 | yes | unit on `ChatService.handle` direct vs pipeline + `extractChatMeta` headers. | keep |
| chat-stream.test.ts | A | 0 | 0 | yes | real `wrapStreamForChat` against mock memory; HIGH-9 write-after-close regression. | keep |
| clock.test.ts | A | 0 | 0 | yes | pure unit on `getMoscowNow`/`getMoscowDate`. | keep |
| code-tool-hardcoded-facts.test.ts | A | 0 | 0 | yes | pure unit on F-2 validator; reproduces real prod incident snapshot. | keep |
| code-tool-sandbox.test.ts | A | 0 | 0 | yes | real `executeSandboxed`; eval/Function block; template literal handling. | keep |
| context-compressor.test.ts | A | 2 | 0 | yes | real `MemoryDB` + real compressor; verifies head/tail kept + facts persisted. | keep |
| cross-agent-isolation.test.ts | A | 0 | 0 | yes | B-1 critical: real DB, agent_id filter on FTS + RAG; ownership enforcement. | keep |
| db.test.ts | A | 0 | 0 | yes | real DB across all 4 layers + FTS + vec. Foundational regression suite. | keep |
| digest-format.test.ts | A | 0 | 0 | yes | pure unit on `composeDailyRollup`/`composeInstantAlert`. | keep |
| done-with-artifact.test.ts | C | 2 | 0 | partial | mostly real but final `runToolCall` uses heavy `as any` mocks for executor/router/registry. | rewrite tool-dispatch case with real registry |
| error-handler.test.ts | C | 5 | 0 | no | reimplements `onError` inline (comment: "miniature copy"); does not test the real bootstrap handler. | rewrite to import real handler from bootstrap |
| freelance-leads.test.ts | A | 0 | 0 | yes | real DB CRUD on freelance_leads. | keep |
| freelance-parsers.test.ts | A | 0 | 0 | yes | real fixture parsing + real-snapshot regression. | keep |
| freelance-routes.test.ts | A | 0 | 0 | yes | real Elysia + DB; envelope + status filter + 404. | keep |
| fts-log.test.ts | A | 0 | 0 | yes | real DB; M-04 migration + triggers + FTS + RAG layer log. High-signal. | keep |
| fts-utils.test.ts | A | 0 | 0 | yes | pure unit on `sanitizeFtsQuery`. | keep |
| hardening.test.ts | C | 1 | 0 | partial | `console.assert` script-style; `as any` on router; tests RAG cache + recency but not via `bun:test`. | rewrite with describe/test/expect |
| hippocampus-cap.test.ts | A | 1 | 0 | yes | pure unit on cap-guard + telemetry counters; single `as any` on log stub. | keep |
| hippocampus-extraction.test.ts | A | 0 | 0 | yes | pure unit on extractor prompt content (anti-economy guard). | keep |
| hippocampus-task-budget.test.ts | A | 1 | 0 | yes | real DB + real registry; verifies budget consumption across task_* tools. | keep |
| http-client.test.ts | A | 0 | 0 | yes | real Bun.serve + `fetchJson`/`fetchStream`; abort/timeout/retry coverage. | keep |

## Top-10 best A files (highest signal)
1. `cross-agent-isolation.test.ts` — B-1 critical: real DB, every agent_id filter path + ownership rejection.
2. `approval-flow.test.ts` — full integration of approval gate plugin + DB + dispatcher; 10 scenarios incl. expiry/unavailable.
3. `agent-pool-claim-race.test.ts` — 50-iter atomic claim race against real DB; would catch a real concurrency regression instantly.
4. `fts-log.test.ts` — migration + triggers + searchLog + RAG branch + bumpAccess guard, all on real DB.
5. `db.test.ts` — foundational MemoryDB across all 4 layers + FTS + vec round-trip.
6. `auth-coverage.test.ts` — live-listen `createApp` covering every gated/public endpoint.
7. `backup-integration.test.ts` — spawns real `restore-backup.ts` subprocess; refuse/confirm/schema-mismatch.
8. `bifrost-provider.test.ts` — real Bun.serve fake; payload, errors, redaction, abort, embed/rerank refusal.
9. `agent-pool-engine.test.ts` — real `runTick` covering complete/noop/failed/zombie/re-entrancy.
10. `http-client.test.ts` — real server; abort/timeout/retry/HttpError contract pinned.

## Top-10 worst B/C files (delete or rewrite first)
1. `arbitration.test.ts` — uses `console.assert` + dynamic re-import + `process.env` mutation; violates CLAUDE.md §12 (no script-style). Rewrite first.
2. `hardening.test.ts` — same script-style pattern; mixes RAG + ProviderError + recency in one file. Split + rewrite.
3. `error-handler.test.ts` — tests an in-test reimplementation of `onError` rather than the real bootstrap handler — false-confidence test.
4. `browser-smoke.ts` — not a `bun:test` file (no `.test.ts`); manual script. Either rename `*.live.ts` or delete.
5. `agent-loop-step.test.ts` — `as any` everywhere on deps; brittle hand-rolled stubs that drift with refactors.
6. `agent-loop-request-surface.test.ts` — same brittleness; would benefit from shared test-fixture helper.
7. `done-with-artifact.test.ts` — last block uses heavy `as any` mocks for executor/router/registry; could use real registry like other tests.
8. `baml-esm-smoke.test.ts` — borderline B (tiny smoke), but cheap and catches build-time regressions; keep classified A.
9. *(empty)*
10. *(empty)*

## Patterns observed
- 24 files use real DB (`new MemoryDB("data/test-*.db")` or `:memory:`); 2 files use a stub `MemoryDB`.
- 5 files have ≥5 `as any` casts (`app-bootstrap.test.ts` 10, `auth-coverage.test.ts` 9, `agent-loop-request-surface.test.ts` 5, `agent-loop-step.test.ts` 5, `arbitration.test.ts` 5, `error-handler.test.ts` 5).
- 0 files have a single `expect(mocked).toHaveBeenCalled` — no mock-spy-only assertions found in chunk a-h.
- 2 files use `console.assert` script-style instead of `bun:test` (`arbitration.test.ts`, `hardening.test.ts`) — direct CLAUDE.md §12 violation.
- 1 file is not actually a `*.test.ts` (`browser-smoke.ts`) — orphan in tests/.
- All "approval-*" tests use `:memory:` `bun:sqlite` Database directly (not `MemoryDB`); they bypass the higher-level repo wrapper but still exercise real SQL + real migrations.
- Recurring pattern: real Elysia `app.handle(new Request(...))` instead of a live listen — preferred (faster, no port races) and used consistently.
- Recurring pattern: `Bun.serve({ port: 0 })` for HTTP-client / provider tests — clean, isolated.
- Single biggest cleanup win: rewriting the two `console.assert` files would remove the only remaining anti-pattern flagged by CLAUDE.md in this chunk.
