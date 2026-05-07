#!/usr/bin/env bun
/**
 * Restore a SQLite backup into the live DB.
 *
 *   bun run scripts/restore-backup.ts <path-or-date> [--confirm]
 *
 *   path-or-date:  absolute/relative path to a .db backup file
 *                  OR a YYYY-MM-DD date string resolved under BACKUP_DIR
 *
 * Requires --confirm flag OR SUBBRAIN_RESTORE_CONFIRM=yes.
 * Does NOT restart the daemon — print instructions only.
 */
import { Database } from "bun:sqlite";
import { access, rename } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { logger } from "@subbrain/core/lib/logger";

const log = logger.child("restore");

const DB_PATH = process.env.DB_PATH || "data/subbrain.db";
const BACKUP_DIR = process.env.BACKUP_DIR || `${dirname(DB_PATH)}/backups`;

function readUserVersion(path: string): number {
  const db = new Database(path, { readonly: true });
  try {
    const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
    return row?.user_version ?? 0;
  } finally {
    db.close();
  }
}

/** Resolve source path from arg (date string or literal path). */
function resolveSourcePath(arg: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) {
    return `${BACKUP_DIR}/subbrain-${arg}.db`;
  }
  return resolve(arg);
}

/** Validate source is under BACKUP_DIR prefix. */
function isUnderBackupDir(sourcePath: string): boolean {
  const resolvedBackup = resolve(BACKUP_DIR);
  const resolvedSource = resolve(sourcePath);
  return resolvedSource.startsWith(`${resolvedBackup}/`) || resolvedSource === resolvedBackup;
}

/** Run PRAGMA integrity_check on a backup file. */
function checkIntegrity(path: string): string {
  const db = new Database(path, { readonly: true });
  try {
    const row = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get();
    return row?.integrity_check ?? "unknown";
  } finally {
    db.close();
  }
}

interface RestoreResult {
  ok: boolean;
  message: string;
}

async function runRestore(sourcePath: string): Promise<RestoreResult> {
  // a. Confirm flag/env
  const confirmed =
    process.argv.includes("--confirm") || process.env.SUBBRAIN_RESTORE_CONFIRM === "yes";
  if (!confirmed) {
    return {
      ok: false,
      message: "Aborted: pass --confirm or set SUBBRAIN_RESTORE_CONFIRM=yes",
    };
  }

  // b. Resolve source
  const resolved = resolveSourcePath(sourcePath);

  // c. Under BACKUP_DIR
  if (!isUnderBackupDir(resolved)) {
    return {
      ok: false,
      message: `Aborted: source must be under backup dir (${BACKUP_DIR})`,
    };
  }

  // d. Source exists
  try {
    await access(resolved);
  } catch {
    return { ok: false, message: `Aborted: source not found: ${basename(resolved)}` };
  }

  // e. Integrity check
  const integrity = checkIntegrity(resolved);
  if (integrity !== "ok") {
    return {
      ok: false,
      message: `Aborted: integrity check failed: ${integrity}`,
    };
  }

  // f. Schema version match
  const backupVersion = readUserVersion(resolved);
  const targetVersion = readUserVersion(DB_PATH);
  if (backupVersion !== targetVersion) {
    return {
      ok: false,
      message: `Aborted: schema mismatch (backup=${backupVersion}, target=${targetVersion})`,
    };
  }

  // g. Rename current DB
  const preRestorePath = `${DB_PATH}.pre-restore-${Date.now()}.bak`;
  log.info("rename", { meta: { from: basename(DB_PATH), to: basename(preRestorePath) } });
  await rename(DB_PATH, preRestorePath);

  // h. Copy source to DB_PATH
  const sourceFile = Bun.file(resolved);
  await Bun.write(DB_PATH, sourceFile);

  // i. Done
  log.info("restore", {
    meta: { source: basename(resolved), preRestore: basename(preRestorePath) },
  });
  return {
    ok: true,
    message: `Restore complete. Restart container: docker compose restart subbrain`,
  };
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg || arg === "--confirm") {
    console.error("Usage: bun run scripts/restore-backup.ts <path-or-date> [--confirm]");
    console.error("  path-or-date:  backup file path or YYYY-MM-DD date");
    console.error("  --confirm:     required flag (or SUBBRAIN_RESTORE_CONFIRM=yes)");
    process.exit(1);
  }

  const result = await runRestore(arg);
  console.log(result.message);
  process.exit(result.ok ? 0 : 1);
}

if (import.meta.main) {
  await main();
}
