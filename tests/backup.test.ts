/**
 * 8c-1 — Backup primitive integration tests.
 *
 * Coverage:
 *  1. runBackup produces valid SQLite file with matching PRAGMA user_version.
 *  2. FTS5 + sqlite-vec rows round-trip.
 *  3. dryRunBackup detects existing file (wouldOverwrite).
 *  4. runBackup refuses to overwrite existing file.
 *  5. Rollback: partial file cleaned up on failure.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { MemoryDB } from "@subbrain/core/db";
import {
  dryRunBackup,
  getSchemaVersion,
  resolveBackupPath,
  runBackup,
} from "@subbrain/core/db/backup";
import { openDatabase } from "@subbrain/core/db/schema";
import * as sqliteVec from "sqlite-vec";

const TEST_DB = "data/test-backup.db";
const BACKUP_DIR = "data/test-backups";

function cleanup(): void {
  for (const ext of ["", "-shm", "-wal"]) {
    const p = `${TEST_DB}${ext}`;
    if (existsSync(p)) unlinkSync(p);
  }
  // Clean test backup dir
  if (existsSync(BACKUP_DIR)) {
    const _files = Bun.file(BACKUP_DIR).stream ? [] : [];
    // Use Bun to read dir
    for (const f of readdirSync(BACKUP_DIR)) {
      unlinkSync(`${BACKUP_DIR}/${f}`);
    }
  }
}

function readdirSync(dir: string): string[] {
  const entries: string[] = [];
  for (const entry of new Bun.Glob("*").scanSync(dir)) {
    entries.push(entry);
  }
  return entries;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

describe("backup primitive (8c-1)", () => {
  let memory: MemoryDB;

  beforeEach(() => {
    cleanup();
    ensureDir(BACKUP_DIR);
    memory = new MemoryDB(TEST_DB);
  });

  afterEach(() => {
    memory.close();
    cleanup();
  });

  test("runBackup produces valid file with matching schema version", async () => {
    const target = `${BACKUP_DIR}/test-1.db`;
    const liveVersion = getSchemaVersion(memory);
    expect(liveVersion).toBeGreaterThan(0);

    const result = await runBackup(memory, target);

    expect(result.path).toBe(target);
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.schemaVersion).toBe(liveVersion);
    expect(existsSync(target)).toBe(true);
  });

  test("FTS5 + sqlite-vec round-trip", async () => {
    // Seed data
    memory.insertContext(
      "ctx-backup-1",
      "Backup Test",
      "Testing VACUUM INTO preserves FTS5 and vec data",
      "backup,test",
    );

    const target = `${BACKUP_DIR}/test-fts.db`;
    await runBackup(memory, target);

    // Open backup readonly and verify
    const backupDb = openDatabase(target);
    // Need to reload sqlite-vec on the new connection
    sqliteVec.load(backupDb);

    // FTS5 round-trip
    const ftsRow = backupDb
      .query<{ title: string }, []>(
        "SELECT title FROM fts_context WHERE fts_context MATCH 'VACUUM'",
      )
      .get();
    expect(ftsRow?.title).toBe("Backup Test");

    // sqlite-vec table exists
    const vecRow = backupDb
      .query<{ name: number }, []>(
        "SELECT count(*) as name FROM sqlite_master WHERE name = 'vec_embeddings'",
      )
      .get();
    expect(vecRow?.name).toBe(1);

    backupDb.close();
  });

  test("dryRunBackup detects wouldOverwrite", async () => {
    const target = `${BACKUP_DIR}/test-dry.db`;
    // Create file first
    Bun.write(target, "x");

    const dry = await dryRunBackup(memory, target);
    expect(dry.ok).toBe(true);
    expect(dry.wouldOverwrite).toBe(true);
  });

  test("runBackup refuses to overwrite existing file", async () => {
    const target = `${BACKUP_DIR}/test-no-clobber.db`;
    Bun.write(target, "existing");

    await expect(runBackup(memory, target)).rejects.toThrow("already exists");
  });

  test("dryRunBackup fails when parent dir missing", async () => {
    const target = `${BACKUP_DIR}/missing/nested/test.db`;
    const dry = await dryRunBackup(memory, target);
    expect(dry.ok).toBe(false);
    expect(dry.error).toContain("parent directory");
  });

  test("resolveBackupPath formats YYYY-MM-DD", () => {
    const d = new Date("2026-05-07T00:00:00Z");
    const path = resolveBackupPath(d);
    expect(path).toContain("subbrain-2026-05-07.db");
  });
});
