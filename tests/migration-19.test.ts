import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { migrate, openDatabase } from "@subbrain/core/db/schema";

const TEST_DB = "data/test-migration-19.db";

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

describe("migration 19 — agent_tasks", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  afterEach(() => {
    db.close();
    cleanup();
  });

  test("user_version is 19 after migrate()", () => {
    const { user_version } = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!;
    expect(user_version).toBe(19);
  });

  test("agent_tasks table exists with correct columns", () => {
    const row = db
      .query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name = 'agent_tasks'")
      .get()!;
    expect(row.sql).toContain("CHECK(type IN ('free','clear','check-tg','research','find-new-task'))");
    expect(row.sql).toContain("CHECK(status IN ('pending','running','done','noop','failed'))");
    expect(row.sql).toContain("created_by");
  });

  test("three partial indexes exist", () => {
    const indexes = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'agent_tasks'",
      )
      .all();
    const names = indexes.map((i) => i.name);
    expect(names).toContain("idx_agent_tasks_pending");
    expect(names).toContain("idx_agent_tasks_running");
    expect(names).toContain("idx_agent_tasks_distribution");
  });

  test("idempotent — running migrate() twice does not throw", () => {
    expect(() => migrate(db)).not.toThrow();
    const { user_version } = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!;
    expect(user_version).toBe(19);
  });
});
