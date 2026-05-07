/**
 * 8c-6 — Backup retention + restore CLI integration tests.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneBackups } from "@subbrain/core/db/backup";

const SCRIPT = "scripts/restore-backup.ts";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "sb-backup-"));
}

function cleanupDir(dir: string): void {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    unlinkSync(join(dir, f));
  }
  rmdirSync(dir);
}

function readdirSync(dir: string): string[] {
  const entries: string[] = [];
  for (const entry of new Bun.Glob("*").scanSync(dir)) {
    entries.push(entry);
  }
  return entries;
}

describe("pruneBackups (8c-3)", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    cleanupDir(dir);
  });

  test("keeps only newest N files", async () => {
    for (let i = 1; i <= 10; i++) {
      const d = i.toString().padStart(2, "0");
      writeFileSync(join(dir, `subbrain-2026-01-${d}.db`), "x");
    }

    await pruneBackups(dir, 5);

    const remaining = readdirSync(dir).sort();
    expect(remaining).toEqual([
      "subbrain-2026-01-06.db",
      "subbrain-2026-01-07.db",
      "subbrain-2026-01-08.db",
      "subbrain-2026-01-09.db",
      "subbrain-2026-01-10.db",
    ]);
  });

  test("throws when keepN < 1", async () => {
    expect(pruneBackups(dir, 0)).rejects.toThrow("keepN must be >= 1");
  });

  test("ignores non-matching files", async () => {
    writeFileSync(join(dir, "subbrain-2026-01-01.db"), "x");
    writeFileSync(join(dir, "subbrain-2026-01-02.db"), "y");
    writeFileSync(join(dir, "random-file.txt"), "z");

    await pruneBackups(dir, 1);

    const remaining = readdirSync(dir).sort();
    expect(remaining).toEqual(["random-file.txt", "subbrain-2026-01-02.db"]);
  });
});

describe("restore-backup CLI (8c-4)", () => {
  let backupDir: string;
  let liveDbPath: string;

  beforeEach(() => {
    backupDir = makeTempDir();
    liveDbPath = join(makeTempDir(), "subbrain.db");
    const db = new Database(liveDbPath);
    db.exec("PRAGMA user_version = 22");
    db.close();
  });

  afterEach(() => {
    cleanupDir(backupDir);
    cleanupDir(dirname(liveDbPath));
  });

  test("refuses without confirm flag or env", async () => {
    const backupPath = join(backupDir, "subbrain-2026-01-01.db");
    const db = new Database(backupPath);
    db.exec("PRAGMA user_version = 22");
    db.close();

    const proc = Bun.spawn({
      cmd: ["bun", "run", SCRIPT, backupPath],
      env: { ...process.env, DB_PATH: liveDbPath, BACKUP_DIR: backupDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();

    expect(exitCode).not.toBe(0);
    expect(stdout.toLowerCase()).toContain("confirm");
  });

  test("refuses on schema mismatch", async () => {
    const backupPath = join(backupDir, "subbrain-2026-01-01.db");
    const db = new Database(backupPath);
    db.exec("PRAGMA user_version = 999");
    db.close();

    const proc = Bun.spawn({
      cmd: ["bun", "run", SCRIPT, backupPath, "--confirm"],
      env: { ...process.env, DB_PATH: liveDbPath, BACKUP_DIR: backupDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();

    expect(exitCode).not.toBe(0);
    expect(stdout.toLowerCase()).toMatch(/schema|version|mismatch/);
  });

  test("succeeds with --confirm and matching schema", async () => {
    const backupPath = join(backupDir, "subbrain-2026-01-01.db");
    const db = new Database(backupPath);
    db.exec("CREATE TABLE IF NOT EXISTS test_table (id INTEGER PRIMARY KEY)");
    db.exec("INSERT INTO test_table(id) VALUES (42)");
    db.exec("PRAGMA user_version = 22");
    db.close();

    const proc = Bun.spawn({
      cmd: ["bun", "run", SCRIPT, backupPath, "--confirm"],
      env: { ...process.env, DB_PATH: liveDbPath, BACKUP_DIR: backupDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);

    // Verify restored DB has the data
    const restored = new Database(liveDbPath);
    const row = restored.query<{ id: number }, []>("SELECT id FROM test_table").get();
    expect(row?.id).toBe(42);
    restored.close();

    // Clean up .pre-restore-*.bak
    const parent = dirname(liveDbPath);
    for (const f of readdirSync(parent)) {
      if (f.startsWith("subbrain.db.pre-restore-") && f.endsWith(".bak")) {
        unlinkSync(join(parent, f));
      }
    }
  });
});

function dirname(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx >= 0 ? p.slice(0, idx) : ".";
}
