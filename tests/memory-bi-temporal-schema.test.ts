import { describe, expect, test } from "bun:test";
import { MemoryDB } from "../packages/core/src/db";

describe("P3-2 Migration 17 bi-temporal schema", () => {
  test("migration 17 applies cleanly to :memory:", () => {
    const db = new MemoryDB(":memory:");
    const v = db.db.query("PRAGMA user_version").get() as { user_version: number };
    expect(v.user_version).toBe(19);
  });

  test("shared_memory has valid_from, valid_to, observed_at", () => {
    const db = new MemoryDB(":memory:");
    const cols = db.db
      .query<{ name: string }, []>("PRAGMA table_info(shared_memory)")
      .all()
      .map((c) => c.name);
    expect(cols).toContain("valid_from");
    expect(cols).toContain("valid_to");
    expect(cols).toContain("observed_at");
  });

  test("layer2_context has valid_from, valid_to, observed_at", () => {
    const db = new MemoryDB(":memory:");
    const cols = db.db
      .query<{ name: string }, []>("PRAGMA table_info(layer2_context)")
      .all()
      .map((c) => c.name);
    expect(cols).toContain("valid_from");
    expect(cols).toContain("valid_to");
    expect(cols).toContain("observed_at");
  });

  test("shared_memory insert + read round-trips bi-temporal columns", () => {
    const db = new MemoryDB(":memory:");
    db.insertShared("s1", "cat", "content", "tag", "src", {
      valid_from: 1000,
      valid_to: 2000,
      observed_at: 500,
    });
    const row = db.getShared("s1")!;
    expect(row.valid_from).toBe(1000);
    expect(row.valid_to).toBe(2000);
    expect(row.observed_at).toBe(500);
  });

  test("shared_memory nullable behavior works", () => {
    const db = new MemoryDB(":memory:");
    db.insertShared("s2", "cat", "content");
    const row = db.getShared("s2")!;
    expect(row.valid_from).toBeNull();
    expect(row.valid_to).toBeNull();
    expect(row.observed_at).toBeNull();
  });

  test("layer2_context insert + read round-trips bi-temporal columns", () => {
    const db = new MemoryDB(":memory:");
    db.insertContext("c1", "title", "content", "tag", [], "agent", {
      valid_from: 3000,
      valid_to: 4000,
      observed_at: 2500,
    });
    const row = db.getContext("c1")!;
    expect(row.valid_from).toBe(3000);
    expect(row.valid_to).toBe(4000);
    expect(row.observed_at).toBe(2500);
  });

  test("layer2_context nullable behavior works", () => {
    const db = new MemoryDB(":memory:");
    db.insertContext("c2", "title", "content");
    const row = db.getContext("c2")!;
    expect(row.valid_from).toBeNull();
    expect(row.valid_to).toBeNull();
    expect(row.observed_at).toBeNull();
  });

  test("shared_memory update round-trips bi-temporal columns", () => {
    const db = new MemoryDB(":memory:");
    db.insertShared("s3", "cat", "content");
    db.updateShared("s3", { valid_from: 111, valid_to: 222, observed_at: 333 });
    const row = db.getShared("s3")!;
    expect(row.valid_from).toBe(111);
    expect(row.valid_to).toBe(222);
    expect(row.observed_at).toBe(333);
  });

  test("layer2_context update round-trips bi-temporal columns", () => {
    const db = new MemoryDB(":memory:");
    db.insertContext("c3", "title", "content");
    db.updateContext("c3", { valid_from: 444, valid_to: 555, observed_at: 666 });
    const row = db.getContext("c3")!;
    expect(row.valid_from).toBe(444);
    expect(row.valid_to).toBe(555);
    expect(row.observed_at).toBe(666);
  });
});
