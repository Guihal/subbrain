import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "bun";

const SCRIPT = "scripts/tg-pii-backfill.ts";

function runScript(
  args: string[],
  env?: Record<string, string>,
): { stdout: string; stderr: string; exitCode: number } {
  const proc = spawnSync(["bun", "run", SCRIPT, ...args], {
    env: { ...process.env, ...env },
    cwd: "/usr/projects/subbrain",
  });
  return {
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    exitCode: proc.exitCode,
  };
}

describe("tg-pii-backfill", () => {
  const testDbPath = "data/test-backfill-temp.db";

  beforeAll(() => {
    const db = new Database(testDbPath, { create: true });
    db.run(`DROP TABLE IF EXISTS tg_messages`);
    db.run(`
      CREATE TABLE tg_messages (
        message_id INTEGER,
        chat_id TEXT,
        chat_name TEXT DEFAULT '',
        from_name TEXT DEFAULT '',
        ts INTEGER,
        text TEXT,
        created_at INTEGER DEFAULT (unixepoch()),
        PRIMARY KEY(chat_id, message_id)
      )
    `);
    db.close();
  });

  afterAll(() => {
    try {
      Bun.file(testDbPath).delete();
    } catch {
      // ignore
    }
  });

  test("refuses to run without --confirm", () => {
    const result = runScript([]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toInclude("--confirm");
  });

  test("idempotent backfill scrubs PII and is idempotent", () => {
    const db = new Database(testDbPath);
    db.run("DELETE FROM tg_messages");
    db.run(
      "INSERT INTO tg_messages (message_id, chat_id, text, ts) VALUES (?, ?, ?, ?)",
      1,
      "c1",
      "Contact me at alice@example.com or call +7 999 123-45-67",
      0,
    );
    db.close();

    const r1 = runScript(["--confirm"], { DB_PATH: testDbPath });
    expect(r1.exitCode).toBe(0);
    expect(r1.stdout).toInclude("1 rows processed");
    expect(r1.stdout).toInclude("1 changed");

    const db2 = new Database(testDbPath);
    const row1 = db2.query("SELECT text FROM tg_messages WHERE message_id = 1").get() as {
      text: string;
    };
    db2.close();
    expect(row1.text).toInclude("[REDACTED:email]");
    expect(row1.text).toInclude("[REDACTED:phone]");
    expect(row1.text).not.toInclude("alice@example.com");

    const r2 = runScript(["--confirm"], { DB_PATH: testDbPath });
    expect(r2.exitCode).toBe(0);
    expect(r2.stdout).toInclude("0 changed");

    const db3 = new Database(testDbPath);
    const row2 = db3.query("SELECT text FROM tg_messages WHERE message_id = 1").get() as {
      text: string;
    };
    db3.close();
    expect(row2.text).toBe(row1.text);
  });

  test("progress output contains counts but no PII", () => {
    const db = new Database(testDbPath);
    db.run("DELETE FROM tg_messages");
    for (let i = 0; i < 600; i++) {
      db.run(
        "INSERT INTO tg_messages (message_id, chat_id, text, ts) VALUES (?, ?, ?, ?)",
        i,
        "c1",
        `msg ${i} and email user${i}@test.com`,
        i,
      );
    }
    db.close();

    const result = runScript(["--confirm"], { DB_PATH: testDbPath });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toInclude("600/600 rows processed");
    expect(result.stdout).not.toInclude("user0@test.com");
    expect(result.stdout).not.toInclude("user599@test.com");
  });

  test("empty table prints no rows and exits 0", () => {
    const emptyDb = "data/test-backfill-empty.db";
    const db = new Database(emptyDb, { create: true });
    db.run(`DROP TABLE IF EXISTS tg_messages`);
    db.run(`
      CREATE TABLE tg_messages (
        message_id INTEGER,
        chat_id TEXT,
        chat_name TEXT DEFAULT '',
        from_name TEXT DEFAULT '',
        ts INTEGER,
        text TEXT,
        created_at INTEGER DEFAULT (unixepoch()),
        PRIMARY KEY(chat_id, message_id)
      )
    `);
    db.close();

    const result = runScript(["--confirm"], { DB_PATH: emptyDb });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toInclude("No rows to backfill");

    try {
      Bun.file(emptyDb).delete();
    } catch {
      // ignore
    }
  });
});
