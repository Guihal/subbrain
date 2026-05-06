/**
 * 8c-1 — Online backup primitive.
 *
 * Uses SQLite `VACUUM INTO` (the only viable approach per spec).
 * - Online: brief lock only at the end.
 * - Round-trips FTS5 + sqlite-vec shadow tables.
 * - Produces a defragmented standalone file.
 *
 * Rollback path:
 *   If VACUUM INTO fails mid-operation, the target file is either
 *   absent or partially written. The caller should delete the partial
 *   file and retry. No mutation of the live DB occurs.
 */

import { access, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { MemoryDB } from "../index";
import { logger } from "../../lib/logger";

const log = logger.child("backup");

export interface BackupResult {
  path: string;
  sizeBytes: number;
  durationMs: number;
  schemaVersion: number;
}

export interface BackupDryRunResult {
  ok: boolean;
  targetPath: string;
  schemaVersion: number;
  wouldOverwrite: boolean;
  error?: string;
}

const DB_PATH = process.env.DB_PATH || "data/subbrain.db";
const BACKUP_DIR = process.env.BACKUP_DIR || `${dirname(DB_PATH)}/backups`;

/** Resolve backup path with date suffix (UTC YYYY-MM-DD). */
export function resolveBackupPath(date = new Date()): string {
  const d = date.toISOString().slice(0, 10);
  return `${BACKUP_DIR}/subbrain-${d}.db`;
}

/** Read PRAGMA user_version from the live DB. */
export function getSchemaVersion(memory: MemoryDB): number {
  const row = memory.db.query<{ user_version: number }, []>(
    "PRAGMA user_version",
  ).get();
  return row?.user_version ?? 0;
}

/**
 * Dry-run: validate pre-conditions without writing.
 * Checks: schema version readable, parent dir exists, target not present.
 */
export async function dryRunBackup(
  memory: MemoryDB,
  targetPath: string,
): Promise<BackupDryRunResult> {
  const schemaVersion = getSchemaVersion(memory);

  let wouldOverwrite = false;
  try {
    await access(targetPath);
    wouldOverwrite = true;
  } catch {
    // ENOENT → safe
  }

  const parent = dirname(targetPath);
  try {
    await access(parent);
  } catch {
    return {
      ok: false,
      targetPath,
      schemaVersion,
      wouldOverwrite,
      error: `parent directory does not exist: ${basename(parent)}`,
    };
  }

  return { ok: true, targetPath, schemaVersion, wouldOverwrite };
}

/**
 * Run VACUUM INTO backup.
 *
 * Pre-flight:
 *   1. targetPath must not already exist.
 *   2. Parent directory must exist.
 *   3. Schema version read from live DB for metadata.
 *
 * Post-flight:
 *   4. Verify backup file exists and has non-zero size.
 *   5. Return metadata envelope.
 */
export async function runBackup(
  memory: MemoryDB,
  targetPath: string,
): Promise<BackupResult> {
  const dry = await dryRunBackup(memory, targetPath);
  if (!dry.ok) {
    throw new Error(dry.error);
  }
  if (dry.wouldOverwrite) {
    throw new Error(`backup target already exists: ${basename(targetPath)}`);
  }

  const schemaVersion = dry.schemaVersion;
  const t0 = performance.now();

  log.info("VACUUM INTO start", {
    meta: { target: basename(targetPath), schemaVersion },
  });

  memory.db.run(`VACUUM INTO '${targetPath.replace(/'/g, "''")}'`);

  const durationMs = Math.round(performance.now() - t0);

  const st = await stat(targetPath);
  if (st.size === 0) {
    throw new Error("backup file has zero size after VACUUM INTO");
  }

  log.info("VACUUM INTO done", {
    meta: { target: basename(targetPath), sizeBytes: st.size, durationMs, schemaVersion },
  });

  return {
    path: targetPath,
    sizeBytes: st.size,
    durationMs,
    schemaVersion,
  };
}
