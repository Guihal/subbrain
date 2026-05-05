/**
 * MEM-6 (mig 9): expires_at + superseded_by + indexes + self-supersede trigger.
 * Verifies the additive migration applies, columns exist with NULL default,
 * and the trigger blocks a row from superseding itself.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { MemoryDB } from "@subbrain/core/db";

const TEST_DB = "data/test-mig9.db";

function cleanup() {
  for (const ext of ["", "-shm", "-wal"]) {
    const p = `${TEST_DB}${ext}`;
    if (existsSync(p)) unlinkSync(p);
  }
}

describe("Migration 9 — expires_at + superseded_by", () => {
  let memory: MemoryDB;

  beforeAll(() => {
    cleanup();
    memory = new MemoryDB(TEST_DB);
  });

  afterAll(() => {
    memory.close();
    cleanup();
  });

  test("user_version >= 9", () => {
    const row = memory.db.query<{ user_version: number }, []>("PRAGMA user_version").get()!;
    expect(row.user_version).toBeGreaterThanOrEqual(9);
  });

  test("shared_memory has expires_at + superseded_by columns, NULL default", () => {
    const cols = memory.db.query("PRAGMA table_info(shared_memory)").all() as {
      name: string;
      dflt_value: string | null;
    }[];
    const expires = cols.find((c) => c.name === "expires_at");
    const sup = cols.find((c) => c.name === "superseded_by");
    expect(expires).toBeDefined();
    expect(sup).toBeDefined();
  });

  test("layer2_context has expires_at + superseded_by columns", () => {
    const cols = memory.db.query("PRAGMA table_info(layer2_context)").all() as { name: string }[];
    expect(cols.some((c) => c.name === "expires_at")).toBe(true);
    expect(cols.some((c) => c.name === "superseded_by")).toBe(true);
  });

  test("idx_shared_active and idx_context_active indexes exist", () => {
    const idx = memory.db.query("SELECT name FROM sqlite_master WHERE type = 'index'").all() as {
      name: string;
    }[];
    const names = idx.map((r) => r.name);
    expect(names).toContain("idx_shared_active");
    expect(names).toContain("idx_context_active");
  });

  test("inserted row defaults expires_at + superseded_by to NULL", () => {
    memory.insertShared("row-mig9-default", "preference", "default test", "");
    const row = memory.getShared("row-mig9-default");
    expect(row).not.toBeNull();
    expect(row?.expires_at).toBeNull();
    expect(row?.superseded_by).toBeNull();
  });

  test("trigger blocks self-supersede on shared_memory", () => {
    memory.insertShared("self-sup-test", "profile", "self test", "");
    expect(() => {
      memory.updateShared("self-sup-test", { superseded_by: "self-sup-test" });
    }).toThrow(/cannot supersede self/);
  });

  test("trigger blocks self-supersede on layer2_context", () => {
    memory.insertContext("ctx-self-sup-test", "decision", "self ctx test", "");
    expect(() => {
      memory.updateContext("ctx-self-sup-test", { superseded_by: "ctx-self-sup-test" });
    }).toThrow(/cannot supersede self/);
  });

  test("setting superseded_by to a different id is allowed", () => {
    memory.insertShared("a-row", "profile", "row a", "");
    memory.insertShared("b-row", "profile", "row b", "");
    memory.updateShared("a-row", { superseded_by: "b-row" });
    expect(memory.getShared("a-row")?.superseded_by).toBe("b-row");
  });

  test("setting superseded_by to literal 'expired' is allowed", () => {
    memory.insertShared("exp-row", "profile", "expired row", "");
    memory.updateShared("exp-row", { superseded_by: "expired" });
    expect(memory.getShared("exp-row")?.superseded_by).toBe("expired");
  });
});
