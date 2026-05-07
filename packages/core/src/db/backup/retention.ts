/**
 * 8c-3 — Backup retention pruner.
 *
 * Lists files matching subbrain-YYYY-MM-DD.db, sorts by date ascending,
 * deletes oldest until count <= keepN.
 */

import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../../lib/logger";

const log = logger.child("backup.retention");

const BACKUP_PATTERN = /^subbrain-\d{4}-\d{2}-\d{2}\.db$/;
const MAX_CANDIDATES = 1000;

interface BackupFile {
  path: string;
  date: Date;
}

/** Parse YYYY-MM-DD from a matched filename. */
function parseDateFromName(name: string): Date {
  const d = name.slice(9, 19);
  return new Date(`${d}T00:00:00Z`);
}

/**
 * Prune dated backups in `dir`, keeping the newest `keepN` files.
 *
 * - Only files matching /^subbrain-\d{4}-\d{2}-\d{2}\.db$/ are considered.
 * - Throws if keepN < 1.
 * - If >1000 candidates found, logs warn and aborts (config bug signal).
 * - ENOENT during unlink is accepted (race) and logged as warn.
 */
export async function pruneBackups(dir: string, keepN: number): Promise<void> {
  if (keepN < 1) {
    throw new Error(`keepN must be >= 1, got ${keepN}`);
  }

  const entries = await readdir(dir);
  const candidates: BackupFile[] = [];

  for (const name of entries) {
    if (BACKUP_PATTERN.test(name)) {
      candidates.push({ path: join(dir, name), date: parseDateFromName(name) });
    }
  }

  if (candidates.length <= keepN) {
    log.info("prune skip", { meta: { dir, keepN, total: candidates.length } });
    return;
  }

  if (candidates.length > MAX_CANDIDATES) {
    log.warn("prune abort", {
      meta: { dir, candidates: candidates.length, max: MAX_CANDIDATES },
    });
    return;
  }

  candidates.sort((a, b) => a.date.getTime() - b.date.getTime());
  const toDelete = candidates.slice(0, candidates.length - keepN);

  for (const file of toDelete) {
    try {
      await unlink(file.path);
      log.info("prune deleted", { meta: { path: file.path } });
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") {
        log.warn("prune race ENOENT", { meta: { path: file.path } });
      } else {
        throw err;
      }
    }
  }
}
