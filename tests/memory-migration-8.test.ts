/**
 * Migration 8 (MEM-5 / PR 22a): confidence REAL + status TEXT columns on
 * shared_memory and layer2_context, CHECK enforced via BEFORE INSERT/UPDATE
 * triggers (SQLite cannot ALTER ADD CHECK). Existing rows default to
 * status='active' via column DEFAULT — back-compat preserved.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, unlinkSync } from "node:fs";
import { migrate, openDatabase } from "../src/db/schema";

const TEST_DB = "data/test-migration-8.db";

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

describe("schema migration 8 — confidence/status (MEM-5)", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  afterEach(() => {
    db.close();
    cleanup();
  });

  test("user_version >= 8 after migrate()", () => {
    const { user_version } = db
      .query<{ user_version: number }, []>("PRAGMA user_version")
      .get()!;
    expect(user_version).toBeGreaterThanOrEqual(8);
  });

  test("shared_memory exposes confidence + status columns", () => {
    const cols = db
      .query<{ name: string; type: string; dflt_value: string | null }, []>(
        "PRAGMA table_info(shared_memory)",
      )
      .all();
    const names = cols.map((c) => c.name);
    expect(names).toContain("confidence");
    expect(names).toContain("status");
    const status = cols.find((c) => c.name === "status")!;
    expect(status.type.toUpperCase()).toBe("TEXT");
    expect(status.dflt_value).toBe("'active'");
  });

  test("layer2_context exposes confidence + status columns", () => {
    const cols = db
      .query<{ name: string; type: string; dflt_value: string | null }, []>(
        "PRAGMA table_info(layer2_context)",
      )
      .all();
    const names = cols.map((c) => c.name);
    expect(names).toContain("confidence");
    expect(names).toContain("status");
  });

  test("inserting shared row without status → default 'active'", () => {
    db.query(
      "INSERT INTO shared_memory (id, category, content) VALUES (?, ?, ?)",
    ).run("s1", "cat", "content");
    const row = db
      .query<{ status: string; confidence: number | null }, [string]>(
        "SELECT status, confidence FROM shared_memory WHERE id = ?",
      )
      .get("s1")!;
    expect(row.status).toBe("active");
    expect(row.confidence).toBeNull();
  });

  test("inserting context row without status → default 'active'", () => {
    db.query(
      "INSERT INTO layer2_context (id, title, content) VALUES (?, ?, ?)",
    ).run("c1", "t", "c");
    const row = db
      .query<{ status: string; confidence: number | null }, [string]>(
        "SELECT status, confidence FROM layer2_context WHERE id = ?",
      )
      .get("c1")!;
    expect(row.status).toBe("active");
    expect(row.confidence).toBeNull();
  });

  test("accepted status values — pending/active/rejected", () => {
    for (const [id, status] of [
      ["s-pending", "pending"],
      ["s-active", "active"],
      ["s-rejected", "rejected"],
    ] as const) {
      db.query(
        "INSERT INTO shared_memory (id, category, content, status) VALUES (?, ?, ?, ?)",
      ).run(id, "cat", "c", status);
    }
    const count = db
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM shared_memory")
      .get()!.c;
    expect(count).toBeGreaterThanOrEqual(3);
  });

  test("shared_memory: invalid status at INSERT → trigger RAISE ABORT", () => {
    expect(() =>
      db
        .query(
          "INSERT INTO shared_memory (id, category, content, status) VALUES (?, ?, ?, ?)",
        )
        .run("bad", "cat", "c", "garbage"),
    ).toThrow(/invalid status/i);
  });

  test("layer2_context: invalid status at INSERT → trigger RAISE ABORT", () => {
    expect(() =>
      db
        .query(
          "INSERT INTO layer2_context (id, title, content, status) VALUES (?, ?, ?, ?)",
        )
        .run("bad", "t", "c", "garbage"),
    ).toThrow(/invalid status/i);
  });

  test("shared_memory: UPDATE status to invalid → trigger fires", () => {
    db.query(
      "INSERT INTO shared_memory (id, category, content) VALUES (?, ?, ?)",
    ).run("s-u", "cat", "c");
    expect(() =>
      db
        .query("UPDATE shared_memory SET status = ? WHERE id = ?")
        .run("bogus", "s-u"),
    ).toThrow(/invalid status/i);
  });

  test("layer2_context: UPDATE status to invalid → trigger fires", () => {
    db.query(
      "INSERT INTO layer2_context (id, title, content) VALUES (?, ?, ?)",
    ).run("c-u", "t", "c");
    expect(() =>
      db
        .query("UPDATE layer2_context SET status = ? WHERE id = ?")
        .run("bogus", "c-u"),
    ).toThrow(/invalid status/i);
  });

  test("indexes idx_shared_status and idx_memory_status exist", () => {
    const rows = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'index'",
      )
      .all();
    const names = rows.map((r) => r.name);
    expect(names).toContain("idx_shared_status");
    expect(names).toContain("idx_memory_status");
  });

  test("migrate() is idempotent — running twice does not throw", () => {
    expect(() => migrate(db)).not.toThrow();
    const { user_version } = db
      .query<{ user_version: number }, []>("PRAGMA user_version")
      .get()!;
    expect(user_version).toBeGreaterThanOrEqual(8);
  });

  test("pre-existing shared_memory rows survive migration with status='active'", () => {
    // Simulate upgrade path: on fresh DB migrate() already applied mig8. This
    // test at minimum pins that rows inserted before a re-migrate keep their
    // status. Re-migrate is a no-op (user_version already at 8+).
    db.query(
      "INSERT INTO shared_memory (id, category, content) VALUES (?, ?, ?)",
    ).run("legacy", "cat", "c");
    migrate(db);
    const row = db
      .query<{ status: string }, [string]>(
        "SELECT status FROM shared_memory WHERE id = ?",
      )
      .get("legacy")!;
    expect(row.status).toBe("active");
  });
});
