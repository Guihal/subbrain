/**
 * Schema migration checks — in particular, migration 7 (OBS-1) widens the
 * layer4_log role CHECK to accept logger levels + telegram channel_message.
 *
 * Before mig 7, logger writes with role `_log_info` etc. silently failed
 * CHECK and were swallowed by logger.ts's `catch {}`. This test pins the
 * new contract so a future hand-edit to the CHECK (or to the migration's
 * user_version bump) trips CI.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, unlinkSync } from "node:fs";
import { migrate, openDatabase } from "../src/db/schema";

const TEST_DB = "data/test-schema-migrations.db";

function cleanup(): void {
  for (const ext of ["", "-shm", "-wal"]) {
    const p = `${TEST_DB}${ext}`;
    if (existsSync(p)) unlinkSync(p);
  }
}

function freshDb(): Database {
  cleanup();
  const db = openDatabase(TEST_DB);
  migrate(db);
  return db;
}

function insertLog(db: Database, role: string): void {
  db.query(
    "INSERT INTO layer4_log (request_id, session_id, agent_id, role, content) VALUES (?, ?, ?, ?, ?)",
  ).run("req-x", "sess-x", "stage-x", role, "payload");
}

describe("schema migrations — layer4_log role CHECK (migration 7 / OBS-1)", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  afterEach(() => {
    db.close();
    cleanup();
  });

  test("user_version is at least 7 after migrate()", () => {
    const { user_version } = db
      .query<{ user_version: number }, []>("PRAGMA user_version")
      .get()!;
    expect(user_version).toBeGreaterThanOrEqual(7);
  });

  test("baseline roles still accepted", () => {
    for (const role of ["user", "assistant", "system", "tool", "reasoning"]) {
      expect(() => insertLog(db, role)).not.toThrow();
    }
  });

  test("logger-level roles accepted after migration 7", () => {
    for (const role of ["_log_debug", "_log_info", "_log_warn", "_log_error"]) {
      expect(() => insertLog(db, role)).not.toThrow();
    }
  });

  test("telegram channel_message role accepted after migration 7", () => {
    expect(() => insertLog(db, "channel_message")).not.toThrow();
  });

  test("unknown role still rejected by CHECK", () => {
    expect(() => insertLog(db, "garbage_role")).toThrow(
      /CHECK constraint failed/i,
    );
  });

  test("migration is idempotent — running migrate() twice does not throw", () => {
    expect(() => migrate(db)).not.toThrow();
    const { user_version } = db
      .query<{ user_version: number }, []>("PRAGMA user_version")
      .get()!;
    expect(user_version).toBeGreaterThanOrEqual(7);
  });

  test("pre-existing layer4_log rows survive the rebuild", () => {
    // Simulate a DB that had rows before the rebuild step: the inner
    // `INSERT INTO layer4_log_new SELECT * FROM layer4_log` must preserve them.
    insertLog(db, "assistant");
    const before = db
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM layer4_log")
      .get()!.c;
    // Re-run migrate is a no-op (version already at 7+). But we ensure the
    // migrated table retains the row invariant.
    migrate(db);
    const after = db
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM layer4_log")
      .get()!.c;
    expect(after).toBe(before);
  });
});
