# Agent-teams task 08c — Phase 8c SQLite backup/restore

**Status:** packetized contract
**Worker model:** STRONG-MODEL ONLY (every packet is `risk_tier: db` or `security`)
**Risk:** db / security across the board — Kimi MUST `FAIL: requires_strong_model` on every packet
**Spec:** `docs/specs/subbrain-main.md:739` ("Phase 8c SQLite backup/restore — must-have before serious autonomy")
**Why now:** no backup today = single point of failure for the SQLite volume holding all 4 memory layers, FTS5 index, sqlite-vec embeddings, raw_log, chats, code_tools, and OAuth-derived state.

## Scope

Phase 8c adds:

1. An online backup primitive that copies the live SQLite DB (with FTS5 +
   sqlite-vec extensions loaded) into a new file without locking writers for
   the full duration. Implementation = `VACUUM INTO`, NOT `bun:sqlite`'s
   `serialize()` (memory-bound) and NOT a file copy (corrupts under WAL).
2. A daily scheduler that produces dated backups and rotates retention.
3. A retention pruner that keeps last N backups, oldest pruned first.
4. An operator-confirmed restore CLI that refuses to run without an explicit
   confirm flag and that validates schema version before swap.
5. A read-only health endpoint exposing last/next backup state for the web UI
   and external monitoring.
6. Tests covering backup round-trip integrity, retention bounds, schema-version
   gate on restore, and FTS5 + sqlite-vec round-trip.

## API choice (locked, not Kimi's call)

**Bun `bun:sqlite` has no `db.backup()` method.** The only Bun-native primitives
are `serialize()` (in-memory Buffer — unusable for >100 MB DBs) and ordinary
SQL. `VACUUM INTO 'path.db'` is therefore the only viable approach: it is
online (only briefly locks at the end), produces a defragmented standalone
file, and round-trips FTS5 + `sqlite-vec` shadow tables. Every packet below
implements with `VACUUM INTO`. Do not propose alternatives in escalation.

## Non-goals (apply to every packet below)

- No off-host upload (S3, B2, rsync to remote, scp). Local volume only.
- No cross-DB replication, no streaming WAL shipping, no PITR.
- No backup compression (gzip/zstd). v1 stays raw `.db`.
- No automatic restore on detected corruption — operator-confirmed only.
- No new dependency on `better-sqlite3`, `sqlite3`, or any non-`bun:sqlite` driver.
- No removal or schema change of any existing table.
- No exposure of any backup endpoint without `authMiddleware`.
- No reading or logging of `.env` content as part of backup metadata.
- No write to any path outside `${DATA_DIR}/backups/` (default `/data/backups/`).

## Packet ordering

```
8c-1 (backup primitive)  ──┐
                           ├──▶ 8c-2 (scheduler) ──▶ 8c-3 (retention)
                           │
                           ├──▶ 8c-5 (status route) ──┐
                           │                           │
                           └──▶ 8c-4 (restore CLI) ────┴──▶ 8c-6 (tests)
```

8c-2/8c-3/8c-5/8c-4 may run in parallel after 8c-1 lands. 8c-6 waits on all
others.

## Glossary (shared)

- **DB_PATH** — `process.env.DB_PATH`, default `/data/subbrain.db`. Set in
  `docker-compose.yml:45`. Live database file.
- **BACKUP_DIR** — `process.env.BACKUP_DIR`, default `${dirname(DB_PATH)}/backups`
  (i.e. `/data/backups/` in container). Resolved once at module load.
- **backup file** — file at `${BACKUP_DIR}/subbrain-YYYY-MM-DD.db` produced by
  `VACUUM INTO`. Date is UTC, formatted `YYYY-MM-DD` (10 chars, zero-padded).
- **schema version** — integer from `PRAGMA user_version` (current = 16, see
  `packages/core/packages/core/src/db/schema.ts:879`).
- **MemoryDB** — class in `packages/core/packages/core/src/db/index.ts:61`; exposes raw `db: Database` for
  pragma reads + `db.run("VACUUM INTO ?", path)`.
- **scheduler** — pattern from `packages/server/packages/server/packages/server/src/app/schedulers.ts` returning `{ stop }`.
- **authMiddleware** — Elysia plugin already used by `packages/server/packages/server/packages/server/src/routes/freelance.ts`,
  `packages/server/packages/server/packages/server/src/routes/memory.ts`. Apply identically to backup status route.
- **VACUUM INTO** — SQLite single-statement online backup. Locks DB only at end
  for atomic file rename; safe with FTS5 + sqlite-vec. Reference:
  https://sqlite.org/lang_vacuum.html § "VACUUM INTO".

---

## 8c-1 — Online backup primitive

> **STRONG-MODEL ONLY.** `risk_tier: db`. Kimi returns `FAIL: requires_strong_model`.

```json
{
  "task_id": "8c-1",
  "goal": "Create src/lib/backup.ts exporting runBackup(memory, targetPath) that uses VACUUM INTO to write a complete SQLite copy and returns {path, sizeBytes, durationMs, schemaVersion}.",
  "non_goals": [
    "Do not call bun:sqlite serialize(); it is memory-bound and unusable for production-sized DBs.",
    "Do not implement a file-copy fallback; it corrupts WAL DBs.",
    "Do not write any file outside the directory of targetPath; do not create the parent directory recursively above one level.",
    "Do not log the absolute DB_PATH or absolute targetPath at info level beyond their basenames; use logger.formatForDb for any meta.",
    "Do not add a new npm dependency; use only bun:sqlite + node:fs/promises + node:path."
  ],
  "allowed_write_paths": [
    "src/lib/backup.ts"
  ],
  "read_context": [
    "packages/core/packages/core/src/db/index.ts:60-100",
    "packages/core/packages/core/src/db/schema.ts:262-280",
    "packages/core/src/lib/logger.ts",
    "CLAUDE.md",
    "docs/tasks/agent-teams/08c-sqlite-backup.md"
  ],
  "risk_tier": "db",
  "escalate_to_strong_model": true,
  "acceptance": [
    "test -f src/lib/backup.ts",
    "grep -E 'VACUUM INTO' src/lib/backup.ts",
    "grep -E 'export (async )?function runBackup' src/lib/backup.ts",
    "! grep -E 'serialize\\(' src/lib/backup.ts",
    "! grep -E 'Bun\\.write|copyFile|cp\\(' src/lib/backup.ts",
    "bunx tsc --noEmit",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-deep-imports.ts"
  ],
  "diff_budget_loc": 120,
  "file_count_max": 1,
  "rollback": "Delete src/lib/backup.ts.",
  "escalation_triggers": [
    "VACUUM INTO fails on the live DB during a smoke test — STOP, do not silently fall back to serialize() or file copy.",
    "FTS5 or sqlite-vec is reported by docs as not safe to copy via VACUUM INTO — STOP and request human confirmation; do not invent workaround.",
    "targetPath already exists — return error, do not overwrite.",
    "Spec asks for streaming output or compression — out of scope, STOP."
  ],
  "glossary": {
    "runBackup signature": "async function runBackup(memory: MemoryDB, targetPath: string): Promise<{path: string; sizeBytes: number; durationMs: number; schemaVersion: number}>",
    "Pre-flight check": "Use fs.access(targetPath) — if it succeeds (no error), file exists → throw; ENOENT means safe to proceed. Parent dir must exist."
  }
}
```

---

## 8c-2 — Daily backup scheduler

> **STRONG-MODEL ONLY.** `risk_tier: db`. Kimi returns `FAIL: requires_strong_model`.

```json
{
  "task_id": "8c-2",
  "goal": "Create packages/agent/src/scheduler/backup.ts exporting installBackupScheduler(deps) that fires once per day at BACKUP_HOUR_UTC (default 4) and calls runBackup() into ${BACKUP_DIR}/subbrain-YYYY-MM-DD.db, skipping when today's file already exists.",
  "non_goals": [
    "Do not run on every interval tick — at most one backup per UTC date.",
    "Do not block process shutdown waiting for an in-flight backup; track it via an inFlight flag and let SIGTERM win after stop().",
    "Do not call retention pruning here; that is 8c-3's job and will be wired separately.",
    "Do not write to a path outside BACKUP_DIR.",
    "Do not silently swallow errors from runBackup; log via logger.error with stage 'backup' and continue."
  ],
  "allowed_write_paths": [
    "packages/agent/src/scheduler/backup.ts",
    "packages/server/packages/server/src/app/schedulers.ts"
  ],
  "read_context": [
    "packages/server/packages/server/src/app/schedulers.ts",
    "packages/agent/packages/agent/src/scheduler/free-agent.ts:1-40",
    "src/lib/backup.ts",
    "packages/core/src/lib/logger.ts",
    "packages/server/packages/server/src/app/deps.ts"
  ],
  "risk_tier": "db",
  "escalate_to_strong_model": true,
  "acceptance": [
    "test -f packages/agent/src/scheduler/backup.ts",
    "grep -E 'export function installBackupScheduler' packages/agent/src/scheduler/backup.ts",
    "grep -E 'BACKUP_HOUR_UTC' packages/agent/src/scheduler/backup.ts",
    "grep -E 'subbrain-[0-9]{4}-[0-9]{2}-[0-9]{2}\\.db' packages/agent/src/scheduler/backup.ts || grep -F 'subbrain-' packages/agent/src/scheduler/backup.ts",
    "grep -E 'installBackupScheduler' packages/server/packages/server/src/app/schedulers.ts",
    "bunx tsc --noEmit",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-deep-imports.ts"
  ],
  "diff_budget_loc": 150,
  "file_count_max": 2,
  "rollback": "Delete packages/agent/src/scheduler/backup.ts and revert the import + call in packages/server/packages/server/src/app/schedulers.ts.",
  "escalation_triggers": [
    "AppDeps does not expose the MemoryDB instance under a stable name — STOP, do not invent a new DI path.",
    "packages/server/packages/server/src/app/schedulers.ts already imports a backup scheduler under a different name — STOP and reconcile, do not double-install.",
    "Required env BACKUP_DIR resolution conflicts with DB_PATH derivation — STOP and request decision."
  ],
  "glossary": {
    "Schedule strategy": "Compute msUntilNextRun(now, BACKUP_HOUR_UTC); setTimeout once; on fire, run + setInterval(24h). On boot, if today's file is missing AND now is past the hour, run a catch-up immediately.",
    "Today's file": "${BACKUP_DIR}/subbrain-${YYYY-MM-DD UTC}.db; existence checked via fs.access."
  }
}
```

---

## 8c-3 — Retention pruner

> **STRONG-MODEL ONLY.** `risk_tier: db`. Kimi returns `FAIL: requires_strong_model`.

```json
{
  "task_id": "8c-3",
  "goal": "Add pruneBackups(dir: string, keepN: number) to src/lib/backup.ts that lists files matching subbrain-YYYY-MM-DD.db, sorts by date ascending, deletes oldest until count <= keepN, and is invoked from packages/agent/src/scheduler/backup.ts after each successful runBackup.",
  "non_goals": [
    "Do not delete files that do not match the subbrain-YYYY-MM-DD.db regex; never glob on '*.db'.",
    "Do not run pruning in parallel with a backup-in-flight; call after runBackup resolves.",
    "Do not allow keepN < 1; throw on invalid input.",
    "Do not implement size-based retention; keep N is by count only in v1.",
    "Do not delete files outside the resolved BACKUP_DIR."
  ],
  "allowed_write_paths": [
    "src/lib/backup.ts",
    "packages/agent/src/scheduler/backup.ts"
  ],
  "read_context": [
    "src/lib/backup.ts",
    "packages/agent/src/scheduler/backup.ts",
    "packages/core/src/lib/logger.ts"
  ],
  "risk_tier": "db",
  "escalate_to_strong_model": true,
  "acceptance": [
    "grep -E 'export (async )?function pruneBackups' src/lib/backup.ts",
    "grep -E 'BACKUP_RETAIN|keepN' packages/agent/src/scheduler/backup.ts",
    "grep -E 'subbrain-[0-9]{4}-[0-9]{2}-[0-9]{2}\\.db' src/lib/backup.ts || grep -E '^subbrain-' src/lib/backup.ts",
    "bunx tsc --noEmit",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-deep-imports.ts"
  ],
  "diff_budget_loc": 120,
  "file_count_max": 2,
  "rollback": "Remove the pruneBackups export from src/lib/backup.ts and revert its call in packages/agent/src/scheduler/backup.ts.",
  "escalation_triggers": [
    "Filesystem race: a backup file appears between readdir and unlink — accept ENOENT during unlink, do not retry the whole prune; log warn.",
    "BACKUP_RETAIN env value is non-numeric or < 1 — STOP, log error, do not prune.",
    "More than 1000 candidate files found — STOP, log warn, do not delete; this signals a config bug."
  ],
  "glossary": {
    "Retention default": "BACKUP_RETAIN env (default 14). Count of dated backups kept after each prune.",
    "Filename regex": "/^subbrain-\\d{4}-\\d{2}-\\d{2}\\.db$/ — anchor both ends; reject anything else."
  }
}
```

---

## 8c-4 — Restore CLI

> **STRONG-MODEL ONLY.** `risk_tier: security`. Kimi returns `FAIL: requires_strong_model`.

```json
{
  "task_id": "8c-4",
  "goal": "Create scripts/restore-backup.ts that takes a backup path or YYYY-MM-DD date, refuses to run unless --confirm or SUBBRAIN_RESTORE_CONFIRM=yes is set, validates schema version against the running migrate() target, and writes the file in place of DB_PATH after backing the existing DB up to ${DB_PATH}.pre-restore-<timestamp>.bak.",
  "non_goals": [
    "Do not stop or restart the daemon process; print operator instructions instead.",
    "Do not run any DML or schema-altering statement on the restored DB; read-only validation only.",
    "Do not delete the pre-restore backup file; it must remain on disk for recovery.",
    "Do not accept a path outside BACKUP_DIR or an absolute path that does not match the BACKUP_DIR prefix.",
    "Do not allow SUBBRAIN_RESTORE_CONFIRM to be the literal string 'true' or '1' — only 'yes' (case-sensitive) bypasses the prompt; otherwise --confirm must be passed.",
    "Do not log or echo .env values, PROXY_AUTH_TOKEN, or any provider key."
  ],
  "allowed_write_paths": [
    "scripts/restore-backup.ts"
  ],
  "read_context": [
    "packages/core/packages/core/src/db/schema.ts:262-300",
    "packages/core/packages/core/src/db/schema.ts:870-885",
    "src/lib/backup.ts",
    "scripts/rollback-migration.ts",
    "CLAUDE.md"
  ],
  "risk_tier": "security",
  "escalate_to_strong_model": true,
  "acceptance": [
    "test -f scripts/restore-backup.ts",
    "grep -E '--confirm|SUBBRAIN_RESTORE_CONFIRM' scripts/restore-backup.ts",
    "grep -E 'PRAGMA user_version' scripts/restore-backup.ts",
    "grep -E 'pre-restore' scripts/restore-backup.ts",
    "bunx tsc --noEmit",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-deep-imports.ts",
    "bun run scripts/restore-backup.ts 2>&1 | grep -i 'confirm' || true"
  ],
  "diff_budget_loc": 220,
  "file_count_max": 1,
  "rollback": "Delete scripts/restore-backup.ts. The pre-restore-<timestamp>.bak file produced by a prior run is the live recovery path.",
  "escalation_triggers": [
    "Backup schema_version does not match the migrate() target version exported by packages/core/packages/core/src/db/schema.ts — STOP, print mismatch, do NOT swap files.",
    "DB_PATH is not writable, parent dir missing, or the process is not running as expected uid — STOP, print error, do NOT swap.",
    "Backup file fails PRAGMA integrity_check (output != 'ok') — STOP, print failure, do NOT swap.",
    "Spec asks for in-process hot reload of the swapped DB — out of scope, STOP and instruct the operator to restart the container."
  ],
  "glossary": {
    "Validation steps (in order)": "1) confirm flag/env present; 2) resolve source path (date → BACKUP_DIR/subbrain-DATE.db, or literal path); 3) source under BACKUP_DIR; 4) source exists; 5) PRAGMA integrity_check on source = 'ok'; 6) PRAGMA user_version on source == migrate target; 7) rename DB_PATH → DB_PATH.pre-restore-<unix_ms>.bak; 8) copy source → DB_PATH; 9) print 'Restore complete. Restart container: docker compose restart subbrain'.",
    "Confirm bypass tokens": "Either CLI flag --confirm OR env var SUBBRAIN_RESTORE_CONFIRM with literal value 'yes'. Anything else aborts."
  }
}
```

---

## 8c-5 — Backup status route

> **STRONG-MODEL ONLY.** `risk_tier: db`. Kimi returns `FAIL: requires_strong_model`.

```json
{
  "task_id": "8c-5",
  "goal": "Create packages/server/src/routes/backup.ts exporting a route GET /v1/backup/status (mounted under authMiddleware) that returns {last_backup_at, last_backup_size, count, oldest, newest, retain, dir} where dates are ISO-8601 strings and sizes are bytes; mount it in the existing route registration site.",
  "non_goals": [
    "Do not expose POST/DELETE on this route; status is read-only in v1.",
    "Do not list every backup file in the response; only aggregate stats + oldest/newest dates.",
    "Do not return absolute filesystem paths beyond BACKUP_DIR; never echo DB_PATH.",
    "Do not query the live DB; data comes from fs.readdir + fs.stat on BACKUP_DIR.",
    "Do not bypass authMiddleware."
  ],
  "allowed_write_paths": [
    "packages/server/src/routes/backup.ts",
    "packages/server/packages/server/src/app/bootstrap.ts"
  ],
  "read_context": [
    "packages/server/packages/server/src/routes/freelance.ts:1-60",
    "packages/server/packages/server/src/routes/memory.ts:1-60",
    "src/lib/backup.ts",
    "packages/core/src/lib/api-envelope.ts",
    "packages/server/packages/server/src/app/bootstrap.ts"
  ],
  "risk_tier": "db",
  "escalate_to_strong_model": true,
  "acceptance": [
    "test -f packages/server/src/routes/backup.ts",
    "grep -E '/v1/backup/status' packages/server/src/routes/backup.ts",
    "grep -E 'authMiddleware' packages/server/src/routes/backup.ts",
    "grep -E 'backupRoute|registerBackup' packages/server/packages/server/src/app/bootstrap.ts",
    "bunx tsc --noEmit",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-deep-imports.ts"
  ],
  "diff_budget_loc": 130,
  "file_count_max": 2,
  "rollback": "Delete packages/server/src/routes/backup.ts and revert its mount in packages/server/packages/server/src/app/bootstrap.ts.",
  "escalation_triggers": [
    "BACKUP_DIR does not exist at request time — return 200 with {count:0, dir, retain} instead of 500.",
    "packages/server/packages/server/src/app/bootstrap.ts mounts routes via a registry helper that this packet's mount call would conflict with — STOP and reconcile, do not duplicate.",
    "Spec asks for a POST to trigger an ad-hoc backup — out of scope in v1, STOP."
  ],
  "glossary": {
    "Response shape": "{ last_backup_at: string|null; last_backup_size: number|null; count: number; oldest: string|null; newest: string|null; retain: number; dir: string }. Dates from filename YYYY-MM-DD parsed at UTC midnight.",
    "Mount point": "Same Elysia .group/.use pattern as packages/server/packages/server/src/routes/freelance.ts; under the same authMiddleware composition used there."
  }
}
```

---

## 8c-6 — Tests

> **STRONG-MODEL ONLY.** `risk_tier: db`. Kimi returns `FAIL: requires_strong_model`.

```json
{
  "task_id": "8c-6",
  "goal": "Create tests/backup.test.ts using bun:test with describe/test/expect that covers: (1) runBackup produces a valid SQLite file with matching PRAGMA user_version; (2) FTS5 + sqlite-vec rows round-trip; (3) pruneBackups keeps exactly keepN files, deleting oldest first; (4) restore-backup.ts refuses to run without --confirm; (5) restore-backup.ts refuses when schema_version differs.",
  "non_goals": [
    "Do not point tests at data/subbrain.db; create per-test temp files in os.tmpdir() and clean them in afterEach.",
    "Do not write top-level code that calls process.exit; this kills bun test runner.",
    "Do not name the file with .live.ts suffix; this is a unit test.",
    "Do not mock bun:sqlite; use real in-memory or temp-file Databases.",
    "Do not require a running server (no bun run packages/server/packages/server/src/index.ts in test setup)."
  ],
  "allowed_write_paths": [
    "tests/backup.test.ts"
  ],
  "read_context": [
    "src/lib/backup.ts",
    "scripts/restore-backup.ts",
    "packages/core/packages/core/src/db/schema.ts",
    "tests/rag.test.ts"
  ],
  "risk_tier": "db",
  "escalate_to_strong_model": true,
  "acceptance": [
    "test -f tests/backup.test.ts",
    "bunx tsc --noEmit",
    "bun test tests/backup.test.ts",
    "grep -E 'describe|test\\(' tests/backup.test.ts",
    "! grep -E 'process\\.exit' tests/backup.test.ts",
    "grep -E 'sqlite_vec|fts5|MATCH' tests/backup.test.ts",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-deep-imports.ts"
  ],
  "diff_budget_loc": 280,
  "file_count_max": 1,
  "rollback": "Delete tests/backup.test.ts.",
  "escalation_triggers": [
    "Restore CLI cannot be invoked in-process without spawning bun — fall back to Bun.spawn with the script path; do not refactor the script for testability.",
    "FTS5 + sqlite-vec extensions are not available on the test runner host — STOP and instruct human; do not skip the round-trip test.",
    "A test relies on data/subbrain.db — STOP, this is a project rule violation (see CLAUDE.md § Conventions)."
  ],
  "glossary": {
    "Round-trip test": "Open temp DB → run migrate() → insert FTS5 row + vec row → runBackup → open backup with new Database(path, {readonly:true}) → assert SELECT returns inserted row + MATCH/vec_search hit.",
    "Restore refuse test": "Bun.spawn(['bun','run','scripts/restore-backup.ts', tempBackup]) without --confirm and without SUBBRAIN_RESTORE_CONFIRM; expect non-zero exit and stderr contains 'confirm'."
  }
}
```
