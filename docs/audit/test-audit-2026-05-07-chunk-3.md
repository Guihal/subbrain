# Test Audit — Chunk 3 (q-z)

Date: 2026-05-07
Files audited: 44

## Summary
- A: 36
- B: 5
- C: 3

## Per-file table

| File | Category | `as any` | `!` | Tests Real Flow? | Rationale (≤120ch) | Suggested Action |
|---|---|---|---|---|---|---|
| rag-active-filter.test.ts | A | 2 | 4 | yes | Real MemoryDB + RAGPipeline; fakeEmbed router but flow asserts FTS+vec+notStale gating | Keep |
| rag-bi-temporal-filter.test.ts | A | 0 | 1 | yes | `:memory:` MemoryDB; covers valid_from/to + AND/OR precedence on real SQL | Keep |
| rag-edge-walk-boost.test.ts | A | 1 | 5 | yes | Stubs MemoryDB.getRelated only (1 method); pure boost-math invariant; clear scope | Keep |
| rag-shared-vec.test.ts | A | 2 | 0 | yes | Real DB; PR24 regression: shared vec hit hydrates snippet/title | Keep |
| rag-status-filter.test.ts | A | 2 | 0 | yes | Real DB + transactions; status='active' gating across FTS+vec hydration | Keep |
| rag.test.ts | C | 2 | 0 | partial | Top-level script style w/ `console.assert` + `console.log`. No describe/test. Pre-bun:test legacy | Rewrite as bun:test |
| rate-limiter.test.ts | A | 0 | 0 | yes | Real RateLimiter incl. critical-vs-low ordering, backoff429 timestamps | Keep |
| redact.test.ts | A | 0 | 0 | yes | Pure fn maskSecrets; idempotency, perf, regex coverage | Keep |
| report-context.test.ts | A | 1 | 0 | yes | Real MemoryDB; validates section order, empty-omit, kill-switch env | Keep |
| repo-rules.test.ts | A | 0 | 0 | yes | Spawns check-file-size + check-deep-imports CLI in STRICT; SQL/fetch greps; whitelist sync | Keep |
| router-overload-per-provider.test.ts | A | 1 | 0 | yes | White-box: stuffs limiter.timestamps, but asserts public isOverloadedFor contract | Keep |
| routes-memory-edges.test.ts | A | 4 | 1 | yes | Real Elysia + MemoryDB + auth; covers 401/422/empty/filter/archive paths | Keep |
| scheduled-mode-registry.test.ts | A | 0 | 0 | yes | Real registry; SCHED-1 hidden-set + env opt-in + OpenAI tools mirror | Keep |
| scheduled-tool-filter.test.ts | A | 0 | 0 | yes | Real DB+repo+CodeToolRegistry; F-3b filter for 4 stateful client tools | Keep |
| scheduler-mode.test.ts | A | 2 | 0 | yes | Mocks AgentService (intentional contract probe — agentMode propagation) | Keep |
| scheduler-regression.test.ts | A | 1 | 0 | yes | LAYER-4 regression: scheduler must use service not loop; intentional minimal mock | Keep |
| schema-migrations.test.ts | A | 0 | 1 | yes | Real DB; mig 7 role CHECK + idempotency + row preservation | Keep |
| shared-embed-write.test.ts | A | 8 | 4 | yes | Real DB+RAG; PR24 + M-01 atomic invariants for 4 writer paths; orphan check | Keep |
| sse-parser.test.ts | A | 0 | 0 | yes | Pure parser fn; delta/reasoning/tool-calls accumulation + finish_reason | Keep |
| stream-utils.test.ts | C | 0 | 0 | yes | Has trailing `console.log` rocket emoji; otherwise OK bun:test, just remove logs | Light cleanup |
| structured-output-arbitration.test.ts | A | 0 | 0 | yes | Pure parser; fence/no-fence/missing-field cases | Keep |
| structured-output-hippocampus.test.ts | A | 0 | 0 | yes | Pure parsers + priority map | Keep |
| system-prompt-mode.test.ts | A | 0 | 0 | yes | Real MemoryDB + ragStub for 1 method; asserts SCHED-1 prompt gating | Keep |
| tasks-retention.test.ts | A | 0 | 4 | yes | Real DB; pruneCompletedTasks digest weeks, embed fail, prefix-collision, history loader | Keep |
| tasks-stale-prune.test.ts | A | 0 | 0 | yes | Real DB; default + env override + done untouched | Keep |
| tasks.test.ts | A | 0 | 0 | yes | Real DB; CRUD + transition matrix + CHECK invariant + ordering + upsert race | Keep |
| telegram-notify.test.ts | B | 5 | 0 | partial | Heavy as-cast surgery on grammy bot.api; spy `_testCalls`; tests notify wiring not value | Rewrite or delete |
| telegram-poller.test.ts | A | 4 | 1 | yes | Real DB + mock router + mock inbox; asserts state, lastId, receipts, remind, concurrency | Keep |
| telegram-search.test.ts | A | 0 | 0 | yes | Real DB FTS; chat/time filters + sanitization + idempotency | Keep |
| telegram-tools.test.ts | B | 6 | 0 | no | All-mock userbot+memory; asserts dispatch returns success/error wrapper, not real flow | Delete |
| tg-chat-policy.test.ts | A | 0 | 2 | yes | Real DB+repo; upsert/list/migration version + idempotent | Keep |
| tg-ingest.test.ts | A | 0 | 0 | yes | Real DB; PII scrub at ingest + insertMany delegation | Keep |
| tg-pii-backfill.test.ts | A | 0 | 0 | yes | Spawns real script against real sqlite; --confirm gate + idempotent + progress redaction | Keep |
| tg-policy-tool.test.ts | A | 0 | 0 | yes | Real DB; setChatPolicy/listKnown round-trip + back-compat | Keep |
| tg-poller-userbot-disjoint.test.ts | A | 4 | 0 | yes | Real DB; bug-5 disjointness assertion; fakeRouter+fakeClient minimal stubs | Keep |
| tg-search-redaction.test.ts | A | 0 | 0 | yes | `:memory:` DB; PII query block + scrubbed-text findability | Keep |
| tg-send-spam-block.test.ts | A | 1 | 0 | yes | Real DB + plugin hook; F-4 focus_blocked gate covers 7 scenarios | Keep |
| tg-send-tool.test.ts | A | 0 | 0 | yes | Real registry+executor; tg_delivery_failed code wrap + success contract | Keep |
| think-tag-transform.test.ts | A | 0 | 1 | yes | Pure stream fn; partial-tag straddling, SSE rewrite, reasoning merge | Keep |
| tool-result-shape.test.ts | A | 0 | 0 | yes | Pure type adapters toLegacy/fromLegacy; roundtrip property | Keep |
| tool-runner.test.ts | A | 8 | 0 | yes | Real DB+executor+registry; SSRF URL guards, dispatch, real timeout race | Keep |
| tool-timeout-abort.test.ts | A | 0 | 0 | yes | Real withToolTimeout; signal-aborted observation, external compose, fast-path | Keep |
| tool-timeouts.test.ts | A | 0 | 0 | yes | Pure fn timeout map | Keep |
| usemarkdown.test.ts | A | 0 | 0 | yes | Real composable; XSS corpus + happy-path markdown survives | Keep |

## Top-10 best A files

1. **shared-embed-write.test.ts** — atomicity invariant, 4 writer paths, orphan COUNT(*) check, embed-fail rollback, compressor SOFT_LIMIT exercised with real char budget. Production-shape regression.
2. **routes-memory-edges.test.ts** — real Elysia bind + auth + DB + envelope shape; covers 401/422/empty/filter/cross-layer; a true integration test.
3. **rag-status-filter.test.ts** — combines FTS+vec+hydration; asserts pending row never leaks via either path.
4. **tasks.test.ts** — full state machine: CRUD, terminal-status guards, CHECK constraints, race, ordering, upsertBySource idempotency.
5. **tasks-retention.test.ts** — week-bucket math, prefix-collision LIKE safety, embed-fail no-write, history-loader pagination edges.
6. **tg-poller-userbot-disjoint.test.ts** — disjointness contract enforced by behavioural shape; would catch any future overlap regression.
7. **schema-migrations.test.ts** — pins user_version + role-CHECK contract + idempotency + row preservation across rebuild.
8. **tool-runner.test.ts** — SSRF guard, scope-timeout map, real hung-router 3.5s timeout race; mostly real wiring.
9. **rag-bi-temporal-filter.test.ts** — exhaustive bi-temporal cases incl. AND/OR precedence regression.
10. **think-tag-transform.test.ts** — stateful streaming parser; partial-tag straddling across feeds, SSE rewriting; tricky logic worth pinning.

## Top-10 worst B/C files

1. **telegram-tools.test.ts** (B) — every dependency is `as any`; asserts that `r.kind === "success"` for trivially-succeeding mocks. Deleting changes nothing.
2. **telegram-notify.test.ts** (B) — surgery on grammy bot.api with as-cast spy `_testCalls`; tests notify ↔ ToolExecutor wiring at call-arg-shape level rather than behaviour. Brittle, low value.
3. **rag.test.ts** (C) — top-level script with `console.assert` + emoji `console.log`; pre-bun:test era. Needs rewrite to describe/test format.
4. **stream-utils.test.ts** (C light) — fine bun:test, but trailing `console.log("🎉…")` and otherwise minor cleanup. Not really a B.
5. **scheduler-mode.test.ts** (A — borderline) — heavy mock of AgentService, but contract-level assertion is intentional and correct. Kept as A.
6. **scheduler-regression.test.ts** (A — borderline) — same mock pattern; explicit regression doc rationale, kept.
7. **tg-send-tool.test.ts** (A — borderline) — uses `{} as MemoryDB / ModelRouter`; scope is registry handler wrapping only, fine.
8. **rag-edge-walk-boost.test.ts** (A — borderline) — minimal MemoryDB stub (1 method), pure boost math; correct scoping.
9. **router-overload-per-provider.test.ts** (A — borderline) — pokes private `limiter.timestamps`. White-box but stable internal contract; acceptable.
10. **rag-shared-vec.test.ts** (A — borderline) — fakeEmbed router, but tests real DB hydration regression specifically. OK.

## Patterns observed

- **Overall quality:** chunk 3 is strong. 36/44 = 82% A. Real `MemoryDB` is the dominant fixture (37/44 files), with consistent `data/test-*.db` naming + cleanup. Almost no top-level `process.exit` or pre-bun:test legacy left (only `rag.test.ts`).
- **Mock-only smell:** the only real B-grade files are `telegram-notify` and `telegram-tools`. Both share the pattern of mocking the entire dependency surface with `as any` and asserting that a thin wrapper returns `success` — i.e. tautological wrapper coverage with no production-flow risk surface.
- **Intentional contract probes:** several files use small stubs (`scheduler-mode`, `scheduler-regression`, `tg-send-tool`, `rag-edge-walk-boost`). Each is justified by a written rationale at the top — these are NOT B; they target a single contract a real fixture would obscure. Keep.
- **`as any` distribution:** concentrated where it should be — fake routers (`fakeEmbed` shape) and grammy internals. Real DB calls almost never need a cast. Top offender by count is `tool-runner.test.ts` (8) — but it's all on mock router/dynamic-tools shapes, not on real-flow assertions.
- **Atomicity / orphan invariants** pattern is excellent (`shared-embed-write.test.ts`): asserts NOT just "wrote", but "no orphan rows" via raw `COUNT(*) WHERE NOT IN (...)`. Same pattern for `tasks` CHECK + `tg-poller-userbot-disjoint` raw_log probe. This is the right shape.
- **Real-script tests:** `tg-pii-backfill.test.ts` and `repo-rules.test.ts` spawn the actual CLI scripts against fixtures. Catches arg-parse + exit-code + integration regressions a unit test cannot.
- **Trailing `console.log("🎉…")`** appears in `rag.test.ts`, `stream-utils.test.ts`, `telegram-tools.test.ts`, `tool-runner.test.ts` — pre-bun:test idiom. Cosmetic; ignore unless rewriting.
- **`!` non-null assertions:** rare and benign — mostly on `result.value` after `r.ok` discriminator (`structured-output-*`) or on PRAGMA `.get()!` (`schema-migrations`). No `as any`/`!`-stacking abuse.
- **No-tier issue:** zero tests use `expect(mocked).toHaveBeenCalled` style. Project convention is behavioural assertion on real fixtures; only the 2 B-files violate by mocking the world and asserting only the wrapper.
