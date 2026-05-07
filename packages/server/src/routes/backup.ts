/**
 * Backup status route — read-only filesystem surface.
 * No SQL, no business logic. Only fs stat + response formatting.
 */

import { basename } from "node:path";
import { readdir, stat } from "node:fs/promises";
import { Elysia } from "elysia";

const BACKUP_DIR = process.env.BACKUP_DIR || "data/backups";
const BACKUP_RETAIN = Number(process.env.BACKUP_RETAIN) || 14;
const FILENAME_RE = /^subbrain-(\d{4})-(\d{2})-(\d{2})\.db$/;

interface BackupFile {
  date: Date;
  size: number;
}

async function scanBackups(dir: string): Promise<BackupFile[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: BackupFile[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = FILENAME_RE.exec(entry.name);
    if (!match) continue;

    const [, y, m, d] = match;
    const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
    if (Number.isNaN(date.getTime())) continue;

    const st = await stat(`${dir}/${entry.name}`);
    files.push({ date, size: st.size });
  }

  return files.sort((a, b) => a.date.getTime() - b.date.getTime());
}

export function backupRoute() {
  return new Elysia({ prefix: "/v1/backup" }).get("/status", async () => {
    let files: BackupFile[] = [];
    try {
      files = await scanBackups(BACKUP_DIR);
    } catch {
      // ENOENT or unreadable → count 0
    }

    if (files.length === 0) {
      return {
        last_backup_at: null,
        last_backup_size: null,
        count: 0,
        oldest: null,
        newest: null,
        retain: BACKUP_RETAIN,
        dir: basename(BACKUP_DIR),
      };
    }

    const last = files[files.length - 1];

    return {
      last_backup_at: last.date.toISOString(),
      last_backup_size: last.size,
      count: files.length,
      oldest: files[0].date.toISOString(),
      newest: last.date.toISOString(),
      retain: BACKUP_RETAIN,
      dir: basename(BACKUP_DIR),
    };
  });
}
