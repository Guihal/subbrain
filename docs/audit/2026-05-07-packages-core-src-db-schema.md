# packages/core/src/db/schema.ts

## File
- Path: packages/core/src/db/schema.ts
- Last modified: 2026-05-06T10:53:29+03:00
- Lines: 1044

## Metrics
- Cyclomatic: 120
- Maintainability Index: 29.26
- Halstead difficulty: 48.79
- Coupling instability: 0 (no afferent/efferent coupling detected at file level)
- Test:code ratio: n/a (no tests in this file; consumed by tests below)
- Functions: 2 exported + 20 anonymous (arrow/lambda inside migrate)
  - Top complex: migrate@71, openDatabase@1
  - Anonymous lambdas inside migrations: mig3 transaction@4, mig4 transaction@4, mig10 transaction@3, mig11 transaction@3, mig12 transaction@3, mig13 transaction@3, mig14 transaction@3, mig15 transaction@3, mig17 transaction@3

## Smells
- [fat-function] `migrate()` is 1022 LOC, cyc=71, MI=29.38 — god function containing 22 sequential migrations + schema bootstrap @line:20
- [deep-nesting] 4-level nesting inside `migrate`: function → version branch → transaction callback → for-loop → try/catch (migs 10,12,13,17) @line:570-583, 677-689, 721-732, 901-909
- [magic-number] Hardcoded `EMBEDDING_DIM = 2048` @line:4 — no env override, no validation against provider model change
- [magic-string] Migration version literals 0..22 scattered across 22 `if (version < N)` blocks — no enum or array-driven loop @line:264,284,301,328, etc.
- [code-duplication] Identical FTS5 trigger triplet pattern (ai/ad/au) repeated 4 times (context, archive, shared, log) @line:137-204, 606-614
- [code-duplication] Identical `layer4_log` rebuild pattern (CREATE new → INSERT SELECT → DROP → RENAME → reindex → re-trigger) repeated in migs 3, 7, 15 @line:301-324, 433-460, 802-863
- [code-duplication] `duplicate column name` try/catch idempotency guard copy-pasted in migs 10, 12, 13, 17 @line:571-578, 678-685, 723-728, 903-907
- [dead-branch] `if (version < 1)` block @line:264 — on fresh DBs `user_version=0`, but `chats` table is already created at @line:231 with the exact same schema including `telegram` in CHECK. Mig 1 is a no-op on fresh DBs and only runs on pre-mig DBs that already have `chats` without `telegram`. The CREATE+INSERT+DROP+RENAME is unreachable in normal flow because the initial CREATE at line:231 already has the constraint.
- [any-cast] `err instanceof Error ? err.message : String(err)` pattern repeated 4 times — could be a typed helper @line:577, 684, 727, 906
- [missing-promise-allsettled] Not applicable (synchronous DB API), but each migration runs sequentially blocking the boot — no parallel safe-migration possible with SQLite, so this is architectural not a smell
- [single-arg-logger] Not applicable — no logger calls in this file
- [raw-sql] Entire file is raw SQL by design (schema layer), but 22 migrations each inline multi-line SQL strings — no SQL template helper or migration runner abstraction
- [empty-block] None observed
- [non-null-assertion] `db.query<...>(...).get()?.user_version ?? 0` @line:263 — safe optional chain, no `!` found
- [god-class] File exports 2 symbols but `migrate` encapsulates 22 versioned migrations — effectively a monolithic migration controller

## Refactor proposal
- Split:
  - `packages/core/src/db/migrations/index.ts` — migration runner loop + version dispatch
  - `packages/core/src/db/migrations/defs.ts` — `MigrationDef = { version: number; name: string; up: (db: Database) => void }` type
  - `packages/core/src/db/migrations/00-bootstrap.ts` — initial schema (tables, indexes, FTS5 triggers, vec_embeddings)
  - `packages/core/src/db/migrations/01-chats-source.ts` — mig 1 (telegram in chats.source)
  - `packages/core/src/db/migrations/02-tg-excluded.ts` — mig 2
  - `packages/core/src/db/migrations/03-log-reasoning.ts` — mig 3 (layer4_log rebuild #1)
  - `packages/core/src/db/migrations/04-tg-messages.ts` — mig 4
  - `packages/core/src/db/migrations/05-freelance.ts` — mig 5
  - `packages/core/src/db/migrations/06-tasks.ts` — mig 6
  - `packages/core/src/db/migrations/07-log-logger-roles.ts` — mig 7 (layer4_log rebuild #2)
  - `packages/core/src/db/migrations/08-confidence-status.ts` — mig 8
  - `packages/core/src/db/migrations/09-expires-superseded.ts` — mig 9
  - `packages/core/src/db/migrations/10-access-tracking.ts` — mig 10
  - `packages/core/src/db/migrations/11-fts-log.ts` — mig 11
  - `packages/core/src/db/migrations/12-shared-kind.ts` — mig 12
  - `packages/core/src/db/migrations/13-salience.ts` — mig 13
  - `packages/core/src/db/migrations/14-memory-edges.ts` — mig 14
  - `packages/core/src/db/migrations/15-archive-confidence.ts` — mig 15 (layer4_log rebuild #3)
  - `packages/core/src/db/migrations/16-focus-shadow.ts` — mig 16
  - `packages/core/src/db/migrations/17-bi-temporal.ts` — mig 17
  - `packages/core/src/db/migrations/18-memory-blocks.ts` — mig 18
  - `packages/core/src/db/migrations/19-agent-tasks.ts` — mig 19
  - `packages/core/src/db/migrations/20-arbitration-transcripts.ts` — mig 20
  - `packages/core/src/db/migrations/21-approvals.ts` — mig 21
  - `packages/core/src/db/migrations/22-tg-chat-policies.ts` — mig 22
  - `packages/core/src/db/schema.ts` — keep `openDatabase()`, `EMBEDDING_DIM`, re-export `migrate` from `migrations/index.ts`
- Extract:
  - `runMigrationBlock(db, version, stmts[])` — wraps `db.transaction(() => { for (const sql of stmts) db.query(sql).run(); })()` + `PRAGMA user_version = N`
  - `runIdempotentMigrationBlock(db, version, stmts[])` — same but with try/catch on `duplicate column name`
  - `rebuildLogTable(db, allowedRoles[])` — shared helper for migs 3, 7, 15
  - `createFts5Triggers(db, table, columns[])` — shared helper for all FTS5 trigger triplets
  - `getUserVersion(db): number` — typed helper replacing inline query
- Replace:
  - No `any` or `!` found — the `err instanceof Error` pattern is type-safe but repetitive; extract to `getErrorMessage(err: unknown): string`
- Safety:
  - Not applicable for Promise.allSettled / AbortSignal / fetchJson — this is synchronous SQLite schema code
  - Consider adding `db.query("PRAGMA foreign_keys").get()` assert after `openDatabase` to verify FK enforcement
  - Consider `db.query("SELECT vec_version()")` sanity check after `sqliteVec.load` to catch extension load failure early

## Risk
- Level: high
- Reason: `migrate()` runs on every server boot; a typo in any migration SQL or version ordering bricks existing DBs on startup. 22 migrations touch the same `user_version` PRAGMA — race conditions impossible (single process) but ordering is critical.
- Test coverage observed:
  - `tests/schema-migrations.test.ts`
  - `tests/memory-migration-8.test.ts`
  - `tests/memory-archive-confidence.test.ts`
  - `tests/migration-19.test.ts`
  - `tests/tg-chat-policy.test.ts`
  - `tests/arbitration-transcript.test.ts`
  - `tests/approval-schema.test.ts`
  - `tests/approval-sweeper.test.ts`
  - `tests/approval-audit.test.ts`
  - `tests/approval-bot.test.ts`
  - `tests/approval-flow.test.ts`
  - `tests/memory-repo.test.ts`
  - `tests/scheduled-tool-filter.test.ts`
