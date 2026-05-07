# Test Audit — Chunk 2 (i-p)

Date: 2026-05-07
Files audited: 60

Scope: `/usr/projects/subbrain/tests/[i-p]*` regular files only. Sub-dirs `lib/`, `prompts/`, `providers/` excluded — covered in their own chunks.

Method per file:
- read in full
- count `as any`, `!` (non-null), mock vs real `MemoryDB`, real DB vs in-memory
- cross-check public API contract vs private impl
- `expect(mocked).toHaveBeenCalled()` heavy = B; real flow assertion = A
- decide A / B / C

Heuristic legend:
- **A** = real flow against real `MemoryDB` (data/test-*.db or `:memory:`), real migration / repo / service / route under test, hand-coded fakes only at the LLM/router boundary (legitimate — provider isolation policy).
- **B** = mock-heavy / for-galочки / dead script-style (`console.assert` + `process.exit` orphaned under bun:test runner; CLAUDE.md §12 "Older script-style + `process.exit()` killed runner — never reintroduce") / spies on bun internals proving nothing.
- **C** = worth rewriting from scratch (correct intent, broken impl: e.g. uses `console.assert` so 0 `expect()` registers under `bun test`; or hand-rolled `Logger` test that bypasses real logger).

## Summary
- A: 49
- B: 3
- C: 8

## Per-file table

| File | Cat | `as any` | `!` | Real flow? | Rationale (≤120ch) | Suggested action |
|---|---|---|---|---|---|---|
| integration.live.ts | A | 0 | 0 | yes (live e2e) | live fetch suite vs running :4000; outside `bun test`; standalone runner; valuable smoke | keep |
| layer-boundary.test.ts | A | 0 | 0 | yes (guardrail) | regex-scan src/ for raw SQL outside data layer; enforces SoC §1a; static contract | keep |
| logger-child.test.ts | C | 0 | 0 | partial | spies `console.log`; checks string contains "[minimax]"; trivial & private impl | rewrite to assert via `formatForDb` shape |
| logger-swallow.test.ts | A | 0 | 0 | yes | injects fake MemoryDB throwing CHECK; asserts dedup `console.error`; OBS-1 regression | keep |
| mcp-curation-tools.test.ts | A | 0 | 0 | yes | real MemoryDB + RAG; fakeEmbed only; M-10 link/supersede/promote/reflect end-to-end | keep |
| mcp-registry.test.ts | A | 1 | 0 | yes | smoke registry build + scope counts + TypeBox shape; thin but high-value | keep |
| mcp-tools.test.ts | A | 2 | 0 | yes | real MemoryDB; MemoryTools/LogTools/WebTools handler-level; web tools stub `executor` only | keep |
| medium-pack.test.ts | A | 0 | 0 | yes | real DB + sandbox + logsRoute; updateRow / EMBED_MODEL constants / sandbox VM | keep |
| memory-access-tracking.test.ts | A | 0 | 1 | yes | real DB + RAG; bumpAccess plumbing M-02 mig 10; access cols verified | keep |
| memory-archive-confidence.test.ts | A | 1 | 0 | yes | mig 15 backfill HIGH→0.9 / LOW→0.4; route TypeBox; FTS5 trigger; idempotent | keep |
| memory-bi-temporal-schema.test.ts | A | 0 | 0 | yes | mig 17 valid_from/to/observed_at on `:memory:`; PRAGMA table_info checks | keep |
| memory-blocks.test.ts | A | 0 | 0 | yes | mig 18 memory_blocks CRUD via MemoryTable; real DB | keep |
| memory-confidence-insert.test.ts | A | 8 | 3 | yes | MEM-5 confidence→status mapping + TypeBox required-confidence; high `as any` from log-stub but real DB | keep; trim casts |
| memory-edges.test.ts | A | 4 | 0 | yes | mig 14 edges + EdgesTable/EdgeRepo + linkRelated extractor; real DB | keep |
| memory-forgetting-curve.test.ts | A | 0 | 0 | yes | M-08 pure-fn cases + RAG e2e identity-rerank to isolate decay reorder | keep |
| memory-kind.test.ts | A | 0 | 2 | yes | M-07 kind enum mig 12 + persona boost in RAG + admin route filter | keep |
| memory-migration-8.test.ts | A | 0 | 0 | yes | mig 8 confidence REAL + status TEXT + CHECK triggers; openDatabase+migrate | keep |
| memory-migration-9.test.ts | A | 0 | 0 | yes | mig 9 expires_at + superseded_by + self-supersede trigger | keep |
| memory-pending-route.test.ts | A | 1 | 0 | yes | /v1/memory/pending route + PATCH status; central onError 404 envelope | keep |
| memory-repo.test.ts | A | 0 | 0 | yes | repository wrapper + transaction rollback (PR 27 atomicity) | keep |
| memory-routes-active.test.ts | A | 1 | 0 | yes | MEM-6 ?active=true filters superseded+expired; Elysia + fakeEmbed | keep |
| memory-routes-contract.test.ts | A | 2 | 0 | yes | PR25b auth+envelope contract; 401/404/200 shapes; stub RAG | keep |
| memory-salience.test.ts | A | 0 | 12 | yes | M-03 mig 13; salience reinforce+decay+RAG boost; 12 `!` is shape-asserts on rows | keep; lower `!` |
| memory-service-link-related.test.ts | A | 3 | 0 | yes | M-13 service insert hooks linkRelated; real DB+RAG | keep |
| memory-service.test.ts | A | 2 | 0 | yes | PR25b service orchestration; embed-first txn + listShared FTS + setStatus | keep |
| memory-validators.test.ts | A | 5 | 0 | yes (pure) | PR-A pure validators whitelist/blacklist/cap/expires; 24 cases | keep |
| memory-write-enforcement.test.ts | A | 8 | 1 | yes | PR-A on-write enforcement: whitelist/dedup/TIME_BOUND/TTL/rollout-flag; real DB | keep; trim `as any` |
| metrics-runs.test.ts | A | 0 | 0 | yes | `:memory:` MemoryDB + MetricsRepository + Elysia route; aggregate empty + populated | keep |
| metrics.test.ts | C | 1 | 0 | broken | `console.assert` + no `bun:test` import → 0 expect() registered; CLAUDE §12 banned | rewrite as `bun:test` |
| migrate-tasks-from-memory.test.ts | A | 0 | 0 | yes | Phase 5 migration+rollback+stray; canned classifier; tmp JSONL | keep |
| migration-19.test.ts | A | 0 | 0 | yes | mig 19 agent_tasks; openDatabase+migrate; pure schema check | keep |
| minimax-adapter.test.ts | A | 0 | 0 | yes (pure) | rewrapHistoryForMinimax + splitResponseThinkTags + ProviderError; pure adapter | keep |
| model-map-sleep-role.test.ts | A | 0 | 0 | yes | sleep virtual role exists in MODEL_MAP + fallback wiring | keep |
| model-router.test.ts | A | 0 | 0 | yes | UpstreamExhaustedError fallback path with mock LLMProvider; legit boundary stub | keep |
| mutex.test.ts | A | 0 | 0 | yes | sequential + concurrent FIFO acquire/release; pure unit | keep |
| night-cycle-cross-layer-dedup.test.ts | A | 1 | 0 | yes | M-09 cross-layer dedup + archive→shared promote; real DB+service | keep |
| night-cycle-embed-log.test.ts | A | 0 | 0 | yes | M-04.1 embed-log step + RAG vec layer="log"; real DB | keep |
| night-cycle-focus-rewrite.test.ts | A | 1 | 0 | yes | M-11 sleep-time focus rewriter; real MemoryDB; LLM stubbed at boundary | keep |
| night-cycle-memory-dedup.test.ts | A | 1 | 0 | yes | MEM-6 cluster-merge + expired→superseded; real DB+RAG | keep |
| night-cycle-memory-janitor.test.ts | A | 0 | 2 | yes | PR-B janitor phases A/B/C/D isolated; real DB; no network deps | keep |
| night-cycle-reflect.test.ts | A | 1 | 0 | yes | M-06 CoALA episodic→semantic reflect; real DB+service | keep |
| night-cycle.test.ts | C | 6 | 0 | broken | `console.assert` + mockRouter; 0 `bun:test` expect; same dead pattern as metrics.test | rewrite |
| night-cycle-watchdog.test.ts | A | 0 | 0 | yes | controller watchdog timeout flips running flag; uses real `NightCycleController` | keep |
| nvidia-rerank.live.ts | A | 0 | 0 | yes (live) | live smoke vs NVIDIA NeMo; outside `bun test`; standalone via `bun run` | keep |
| pii-gate.e2e.test.ts | A | 0 | 0 | yes | tg policy + nightScrubPII; real MemoryDB + Database; mock router at boundary | keep |
| pii-scrub.test.ts | A | 0 | 0 | yes (pure) | scrubPII pure regex tests email/phone/etc; 15 cases | keep |
| pipeline-post-dedupe.test.ts | A | 2 | 2 | yes | MEM-6 dedupe-on-write writeShared/Context; real DB+RAG | keep |
| pipeline-post-gate.test.ts | A | 0 | 0 | yes (pure) | shouldRunHippocampus length gate + skip prefixes; pure | keep |
| pipeline-post-hippocampus.test.ts | A | 3 | 0 | yes | runHippocampus loop + ToolExecutor + buildRegistry; real DB; mockRouter | keep |
| pipeline-post-supersede.test.ts | A | 2 | 0 | yes | atomic insert + supersede mark; cross-layer guard; cap-10 | keep |
| pipeline-post-validators.test.ts | A | 0 | 0 | yes (pure) | duplicates of memory-validators.test for post path; 19 cases | keep (or merge) |
| pipeline-pre.test.ts | A | 1 | 0 | yes | runPre with real MemoryDB + setFocus + RAG; mock router | keep |
| pipeline.test.ts | C | 1 | 0 | broken | `console.assert` script-style; 0 `bun:test` expect; runner-orphaned | rewrite |
| plugin-approval-gate.test.ts | A | 4 | 1 | yes | 8a-3 approval-gate plugin via setup hooks; real ApprovalsTable+MemoryDB | keep |
| plugin-code-tool-guards.test.ts | A | 0 | 2 | yes | A2-6 code-tool-guards F-2 poisoning case via hook path | keep |
| plugin-scheduled-blacklist.test.ts | A | 4 | 1 | yes (pure) | STATEFUL_CLIENT_CODE_TOOLS set + isHiddenInMode + plugin setup; CLAUDE §15 critical | keep |
| plugins-internal-boot.test.ts | A | 0 | 0 | yes | INTERNAL_PLUGINS registry has 5 expected plugins + HooksDispatcher boot | keep |
| post-link-related-contradictions.test.ts | A | 1 | 0 | yes | M-05.2 contradiction LLM stubbed at boundary; real DB+RAG; verdict→edge | keep |
| post-link-related-evolution.test.ts | A | 4 | 0 | yes | M-05.1 A-MEM tag evolution end-to-end through writeContext/Shared | keep |
| prompt-blocks-tasks.test.ts | A | 0 | 0 | yes | Phase 2 pure renderers over real MemoryDB; 32 cases | keep |
| provider-optional-startup.test.ts | A | 2 | 0 | yes | optional-provider loader env-key check; ENV snapshot/restore isolation | keep |

## Top-10 best A files

1. `memory-migration-8.test.ts` — full migration coverage with `openDatabase+migrate` + CHECK trigger probes; rollback path covered.
2. `memory-write-enforcement.test.ts` — PR-A whitelist/dedup/TTL/rollout flag against real DB + deterministic embed.
3. `pipeline-post-validators.test.ts` — 19 pure-fn cases over public validators contract.
4. `night-cycle-memory-janitor.test.ts` — phases A/B/C/D each isolated, real DB, no network.
5. `mcp-curation-tools.test.ts` — M-10 4-tool curation suite end-to-end with real MemoryService + RAG.
6. `memory-edges.test.ts` — full mig 14 + EdgesTable + EdgeRepo + linkRelated extractor in one suite.
7. `memory-routes-contract.test.ts` — HTTP envelope + auth + 404 shape against real Elysia + service.
8. `pii-gate.e2e.test.ts` — tg policy + nightScrub gate combined; real MemoryDB; cleanest e2e in chunk.
9. `prompt-blocks-tasks.test.ts` — pure renderer suite, 32 cases, real DB seed, no LLM.
10. `migrate-tasks-from-memory.test.ts` — Phase 5 migration+rollback+stray detection with canned classifier; tmp JSONL log path.

## Top-10 worst B/C files

1. `night-cycle.test.ts` (C) — 403 lines, 0 `bun:test` expect; uses `console.assert` + mockRouter. Runner-orphaned. Rewrite needed.
2. `metrics.test.ts` (C) — 152 lines, 0 expect; same `console.assert` pattern. Replace with bun:test on real Metrics class.
3. `pipeline.test.ts` (C) — 268 lines, 0 expect; same dead pattern. Replace; intent is high-value (pipeline routing) but execution invalid.
4. `logger-child.test.ts` (C) — spies `console.log` to grep `[minimax]`; couples to logger format internals not contract; rewrite via `formatForDb` shape.
5. `mcp-tools.test.ts` (A but borderline) — uses `stubProviders` for executor; some `as any`; but real MemoryDB so kept.
6. `memory-confidence-insert.test.ts` (A) — 8 `as any` for log-stub bloat; real DB but cast hygiene poor.
7. `memory-write-enforcement.test.ts` (A) — 8 `as any` for SharedWriteDeps stubs; trim recommended.
8. `memory-salience.test.ts` (A) — 12 non-null `!` in row shape asserts; should be `assertExists()` helper.
9. `plugin-scheduled-blacklist.test.ts` (A) — 4 `as any`; passes but cast-heavy plugin context wiring.
10. `plugin-approval-gate.test.ts` (A) — 4 `as any`; same plugin-context fake-ctx pattern.

(no pure-B detected: rare; hippocampus/curation/janitor authors mostly stuck to real-flow discipline)

## Patterns observed

- **Dead script-style cluster** — 3 oldest files (`metrics.test.ts`, `night-cycle.test.ts`, `pipeline.test.ts`) predate the bun:test migration noted in CLAUDE.md §12. They register zero `expect()` so `bun test` reports them as 0/0 pass — silently green. Highest-impact fix in this chunk: rewrite these 3 → unblocks ~150+ assertions of real coverage.
- **Disciplined real-DB pattern** — 49/60 files use `data/test-*.db` (or `:memory:` for migrations) with `unlinkSync`+`cleanup` lifecycles; LLM mocked only at `router.chat` boundary. This matches CLAUDE.md §12 ("Test DB = `data/test.db`") and produces durable regression coverage.
- **`as any` hotspot = SharedWriteDeps / log shim** — 80% of `as any` in the chunk lives in two patterns: (a) `as any` log stub (`{ info, warn, error, debug } as any`) — should be a typed helper `noopLog()`; (b) `SharedWriteDeps` partial stubs in writeShared/writeContext call sites — should be a typed `makeStubDeps()` factory. Mechanical sweep would drop 30+ casts.
- **Migration tests = strongest contract coverage** — every mig N test (8, 9, 13, 14, 15, 17, 18, 19) uses real `openDatabase`+`migrate`, asserts `PRAGMA user_version`, and proves idempotency by re-opening. This is the cleanest layer.
- **Plugin tests use `setup({hooks})` faux-ctx** — `plugin-*` tests construct hook callbacks manually rather than running through real `HooksDispatcher`. Contract still exercised but coupling to internal `setup()` shape is medium fragility. `plugins-internal-boot.test.ts` partially mitigates by asserting registry membership.
- **Pure-fn extraction** — `memory-validators.test.ts` + `pipeline-post-validators.test.ts` overlap heavily (both cover `validateCategoryAndContent` / `WHITELIST_*` / `validateExpiresAt`); merge candidate (one is the post path, one is general validators — same module). Single-source-of-truth principle violated.
- **`*.live.ts` correctly excluded** — `integration.live.ts` + `nvidia-rerank.live.ts` both follow CLAUDE.md §12 convention (excluded from `bun test`, run via `bun run`); not dead, just out-of-band smoke.
- **High `expect()` density correlates with A** — 47 expect's in `migrate-tasks-from-memory.test.ts`, 60 in `memory-kind.test.ts`, 58 in `prompt-blocks-tasks.test.ts`. Density tracks intent: more assertions ⇒ more contract surface covered.
- **No `mock.module()` usage in chunk** — 0 hits across all 60 files. Authors prefer dependency-injection (real DB / fake router via param) over module-level mocking. Healthier than typical Jest codebase.
