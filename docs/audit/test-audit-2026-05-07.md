# Test Audit — Aggregate (2026-05-07)

Source: `tests/` recursive top-level files (`tests/*.test.ts` + `*.live.ts` + `tests/browser-smoke.ts`).
Sub-dirs `tests/lib/`, `tests/prompts/`, `tests/providers/` covered separately by their owning chunks where applicable.
Method per file: full read, count `as any` + `!`, mock-vs-real `MemoryDB`, real-DB vs `:memory:`, public-API contract vs private impl, expect-density.

Per-chunk source files:
- `docs/audit/test-audit-2026-05-07-chunk-1.md` (a-h, 60 files)
- `docs/audit/test-audit-2026-05-07-chunk-2.md` (i-p, 60 files)
- `docs/audit/test-audit-2026-05-07-chunk-3.md` (q-z, 44 files)

## Aggregate summary

| Chunk | Files | A keep | B delete | C rewrite |
|---|---|---|---|---|
| 1 (a-h) | 60 | 49 | 4 | 7 |
| 2 (i-p) | 60 | 49 | 3 | 8 |
| 3 (q-z) | 44 | 36 | 5 | 3 |
| **Total** | **164** | **134** | **12** | **18** |

Coverage health: **82% A** (real-flow against real `MemoryDB` / real Elysia / real CLI subprocess). The dominant pattern is dependency-injection at the LLM/router boundary while everything below stays real — matches CLAUDE.md §12.

The bottom 18% (B + C) is concentrated in two failure modes:
1. **Runner-orphaned `console.assert` legacy** (5 files, pre-bun:test era, register zero `expect()`, silently green under `bun test`) — direct CLAUDE.md §12 violation.
2. **Mock-the-world wrappers** (telegram-notify / telegram-tools / done-with-artifact tail / error-handler reimpl) — mock all dependencies with `as any`, assert tautological wrapper success, no production-flow risk surface.

## CRITICAL findings

### 5 runner-orphaned files (zero `expect()` registered)

These files use `console.assert` + script-style + sometimes `process.exit()` — banned by CLAUDE.md §12 ("Older script-style + `process.exit()` killed runner — never reintroduce"). They appear green under `bun test` but assert nothing.

| File | Lines | Coverage hidden |
|---|---|---|
| `tests/night-cycle.test.ts` | 403 | scrub/translate/compress/verify/dedup orchestration |
| `tests/pipeline.test.ts` | 268 | pipeline routing (pipeline vs direct mode) |
| `tests/metrics.test.ts` | 152 | Metrics class snapshot/aggregate |
| `tests/arbitration.test.ts` | — | ArbitrationRoom routing + parallel |
| `tests/hardening.test.ts` | — | RAG cache + ProviderError + recency |
| `tests/rag.test.ts` | — | RAG pipeline FTS+vec+rerank |

Highest single-PR impact: convert these 6 to `bun:test describe/test/expect` → unblocks ~150-200 real assertions on critical subsystems (night cycle, pipeline routing, arbitration, RAG).

### 7 cast-heavy files (≥5 `as any`)

Localized cast bloat — keep but trim during normal touch. Mostly `noopLog()` shim + `SharedWriteDeps` fake-ctx pattern.

| File | `as any` count | Recommended action |
|---|---|---|
| `app-bootstrap.test.ts` | 10 | Keep — intentional `AppDeps` stub |
| `auth-coverage.test.ts` | 9 | Keep — intentional `AppDeps` stub |
| `memory-confidence-insert.test.ts` | 8 | Trim with typed `noopLog()` helper |
| `memory-write-enforcement.test.ts` | 8 | Trim with typed `makeStubDeps()` factory |
| `shared-embed-write.test.ts` | 8 | Localize — real DB asserts behind casts |
| `tool-runner.test.ts` | 8 | Localize — fake-router shape only |
| `telegram-tools.test.ts` | 6 | Delete (B) |

## Top-N best A files (cross-chunk)

1. `cross-agent-isolation.test.ts` — B-1 critical: real DB, every `agent_id` filter path + ownership rejection.
2. `shared-embed-write.test.ts` — atomicity invariant, 4 writer paths, orphan `COUNT(*)` check, embed-fail rollback, compressor SOFT_LIMIT exercised.
3. `routes-memory-edges.test.ts` — real Elysia + auth + DB + envelope; 401/422/empty/filter/cross-layer.
4. `agent-pool-claim-race.test.ts` — 50-iter atomic claim race against real DB.
5. `tasks.test.ts` — full state machine: CRUD, terminal-status guards, CHECK constraints, race, ordering, upsert idempotency.
6. `db.test.ts` — foundational `MemoryDB` across all 4 layers + FTS + vec round-trip.
7. `auth-coverage.test.ts` — live-listen `createApp` covering every gated/public endpoint.
8. `backup-integration.test.ts` — real subprocess `restore-backup.ts`; refuse/confirm/schema-mismatch.
9. `bifrost-provider.test.ts` — real `Bun.serve` fake; payload, errors, redaction, abort, embed/rerank refusal.
10. `fts-log.test.ts` — migration + triggers + searchLog + RAG branch + bumpAccess on real DB.
11. `memory-write-enforcement.test.ts` — PR-A whitelist/dedup/TTL/rollout-flag against real DB + deterministic embed.
12. `mcp-curation-tools.test.ts` — M-10 4-tool curation suite end-to-end with real `MemoryService` + RAG.
13. `night-cycle-memory-janitor.test.ts` — phases A/B/C/D each isolated, real DB, no network.
14. `tg-poller-userbot-disjoint.test.ts` — disjointness contract enforced by behavioural shape.
15. `repo-rules.test.ts` — spawns `check-file-size` + `check-deep-imports` CLI in STRICT; SQL/fetch greps; whitelist sync.

## Worst B/C files — recommended action priority

### Priority 1 — rewrite (unblocks hidden coverage)

1. `night-cycle.test.ts` (C, 403 lines) — runner-orphaned. Rewrite as `bun:test`. Highest single-file coverage win.
2. `pipeline.test.ts` (C, 268 lines) — runner-orphaned. Rewrite.
3. `metrics.test.ts` (C, 152 lines) — runner-orphaned. Rewrite as `bun:test` against real `Metrics` class.
4. `arbitration.test.ts` (C) — `console.assert` + dynamic re-import + `process.env` mutation. Rewrite.
5. `hardening.test.ts` (C) — same script-style. Split + rewrite (RAG vs ProviderError vs recency).
6. `rag.test.ts` (C) — top-level `console.assert` legacy. Rewrite as describe/test format.

### Priority 2 — delete (mock-the-world tautologies)

7. `telegram-tools.test.ts` (B) — every dependency `as any`; asserts trivially-succeeding mocks return `success`. Delete.
8. `telegram-notify.test.ts` (B) — surgery on grammy `bot.api` with `_testCalls` spy; brittle wiring assertion. Delete or rewrite as integration via real `TelegramBot`.

### Priority 3 — rewrite (broken impl, correct intent)

9. `error-handler.test.ts` (C) — reimplements `onError` inline ("miniature copy"). Rewrite to import real handler from bootstrap.
10. `agent-loop-step.test.ts` (C) — `as any` everywhere on deps; brittle hand-rolled stubs. Rewrite with typed test doubles.
11. `agent-loop-request-surface.test.ts` (C) — same brittleness. Use shared test-fixture helper.
12. `done-with-artifact.test.ts` (C) — final block uses heavy `as any` mocks; could use real registry like other tests in same file.
13. `logger-child.test.ts` (C) — spies `console.log` for `[minimax]`; couples to format internals. Rewrite via `formatForDb` shape.
14. `stream-utils.test.ts` (C-light) — fine `bun:test`, just trailing `console.log("🎉…")`. Cosmetic.

### Priority 4 — orphan

15. `browser-smoke.ts` (B) — not `*.test.ts`; manual script. Either rename `*.live.ts` (matches `integration.live.ts` / `nvidia-rerank.live.ts` pattern) or delete.

## Cross-cutting patterns

**Healthy:**
- Real `MemoryDB` is dominant (~70% of files); `data/test-*.db` naming + `unlinkSync` cleanup is consistent. Matches CLAUDE.md §12.
- Migration tests are the cleanest layer — every mig N test (8, 9, 13, 14, 15, 17, 18, 19) uses real `openDatabase`+`migrate`, asserts `PRAGMA user_version`, proves idempotency.
- Zero `mock.module()` usage across all 164 files. Authors prefer dependency-injection over module-level mocking.
- `app.handle(new Request(...))` preferred over live-listen for Elysia routes — faster, no port races. Live-listen reserved for auth + bootstrap + e2e.
- `Bun.serve({ port: 0 })` for HTTP-client / provider tests — clean, isolated.
- Atomicity / orphan invariants pattern (`shared-embed-write` raw `COUNT(*) WHERE NOT IN`, `tg-poller-userbot-disjoint` raw_log probe) is the right shape.
- `*.live.ts` convention correctly excluded from `bun test` (`integration.live.ts`, `nvidia-rerank.live.ts`).
- Zero `expect(mocked).toHaveBeenCalled` style — project convention is behavioural assertion on real fixtures.

**Unhealthy:**
- Runner-orphaned `console.assert` cluster (6 files) hides ~150-200 assertions of real coverage. Direct CLAUDE.md §12 violation.
- `as any` hotspots = `noopLog()` shim + `SharedWriteDeps` partial stubs. Mechanical sweep with two helpers would drop 30+ casts.
- Plugin tests use manual `setup({hooks})` faux-ctx instead of running through real `HooksDispatcher` — medium fragility, partially mitigated by `plugins-internal-boot.test.ts`.
- `memory-validators.test.ts` + `pipeline-post-validators.test.ts` overlap heavily (same module, different paths) — merge candidate.
- Trailing `console.log("🎉…")` cosmetic noise in 4 files (rag, stream-utils, telegram-tools, tool-runner) — pre-bun:test idiom.

## Recommended action plan

1. **PR A — Unblock hidden coverage** (highest signal):
   - Rewrite 6 runner-orphaned files (night-cycle, pipeline, metrics, arbitration, hardening, rag) as `bun:test describe/test/expect`.
   - Adds ~150-200 real assertions that currently silently no-op.
   - Estimate: 1-2 days, 6 small PRs (one per file).

2. **PR B — Delete tautological wrappers** (low signal removal):
   - Delete `telegram-tools.test.ts`, `telegram-notify.test.ts` (or rewrite latter as real-`TelegramBot` integration).
   - Delete or rename `browser-smoke.ts` → `browser-smoke.live.ts`.
   - Estimate: <1 hour.

3. **PR C — Cast hygiene sweep** (cosmetic, low priority):
   - Add `tests/lib/test-doubles.ts` exporting typed `noopLog()` + `makeStubDeps()`.
   - Sweep 7 hotspot files; drop ~30 `as any` casts.
   - Trim trailing `console.log("🎉…")` in 4 files.
   - Estimate: half a day.

4. **PR D — Rewrite broken-impl C files** (correctness):
   - `error-handler.test.ts` → import real `onError` from bootstrap.
   - `agent-loop-step.test.ts` + `agent-loop-request-surface.test.ts` → shared fixture helper.
   - `done-with-artifact.test.ts` last block → real registry.
   - `logger-child.test.ts` → assert via `formatForDb` shape.
   - Estimate: 1 day, 4 small PRs.

Total cleanup scope: **18 files rewritten + 3 deleted + 7 trimmed = 28 files touched out of 164 (17%)**. The remaining 134 A files are healthy and require no action.

After all 4 PRs: 164 files → 161 files, all `bun:test`-native, zero `console.assert` legacy, zero tautological mock wrappers, ~150+ new real assertions on critical subsystems (night cycle, pipeline, arbitration, RAG).
