import { describe, expect, test } from "bun:test";
import { MemoryDB } from "../packages/core/src/db";

describe("P3-3 bi-temporal active filter in retrieval", () => {
  const now = Math.floor(Date.now() / 1000);

  test("getContextMany excludes future-dated rows", () => {
    const db = new MemoryDB(":memory:");
    db.insertContext("c-future", "title", "content", "", [], "agent", {
      valid_from: now + 10_000,
      valid_to: now + 20_000,
    });
    const rows = db.getContextMany(["c-future"], {
      activeOnly: true,
      notStale: true,
      agentId: "agent",
    });
    expect(rows.length).toBe(0);
  });

  test("getContextMany excludes expired rows", () => {
    const db = new MemoryDB(":memory:");
    db.insertContext("c-expired", "title", "content", "", [], "agent", {
      valid_from: now - 20_000,
      valid_to: now - 10_000,
    });
    const rows = db.getContextMany(["c-expired"], {
      activeOnly: true,
      notStale: true,
      agentId: "agent",
    });
    expect(rows.length).toBe(0);
  });

  test("getContextMany includes currently valid rows", () => {
    const db = new MemoryDB(":memory:");
    db.insertContext("c-now", "title", "content", "", [], "agent", {
      valid_from: now - 10_000,
      valid_to: now + 10_000,
    });
    const rows = db.getContextMany(["c-now"], {
      activeOnly: true,
      notStale: true,
      agentId: "agent",
    });
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe("c-now");
  });

  test("getContextMany includes null-temporal rows", () => {
    const db = new MemoryDB(":memory:");
    db.insertContext("c-null", "title", "content", "", [], "agent");
    const rows = db.getContextMany(["c-null"], {
      activeOnly: true,
      notStale: true,
      agentId: "agent",
    });
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe("c-null");
  });

  test("getSharedMany excludes future-dated rows", () => {
    const db = new MemoryDB(":memory:");
    db.insertShared("s-future", "cat", "content", "", "src", {
      valid_from: now + 10_000,
      valid_to: now + 20_000,
    });
    const rows = db.getSharedMany(["s-future"], { activeOnly: true, notStale: true });
    expect(rows.length).toBe(0);
  });

  test("getSharedMany excludes expired rows", () => {
    const db = new MemoryDB(":memory:");
    db.insertShared("s-expired", "cat", "content", "", "src", {
      valid_from: now - 20_000,
      valid_to: now - 10_000,
    });
    const rows = db.getSharedMany(["s-expired"], { activeOnly: true, notStale: true });
    expect(rows.length).toBe(0);
  });

  test("getSharedMany includes currently valid rows", () => {
    const db = new MemoryDB(":memory:");
    db.insertShared("s-now", "cat", "content", "", "src", {
      valid_from: now - 10_000,
      valid_to: now + 10_000,
    });
    const rows = db.getSharedMany(["s-now"], { activeOnly: true, notStale: true });
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe("s-now");
  });

  test("getSharedMany includes null-temporal rows", () => {
    const db = new MemoryDB(":memory:");
    db.insertShared("s-null", "cat", "content");
    const rows = db.getSharedMany(["s-null"], { activeOnly: true, notStale: true });
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe("s-null");
  });

  test("listContextActive excludes expired rows", () => {
    const db = new MemoryDB(":memory:");
    db.insertContext("c-list", "title", "content", "", [], "agent", {
      valid_from: now - 20_000,
      valid_to: now - 10_000,
    });
    const { items, total } = db.listContextActive();
    expect(items.length).toBe(0);
    expect(total).toBe(0);
  });

  test("listSharedActive excludes expired rows", () => {
    const db = new MemoryDB(":memory:");
    db.insertShared("s-list", "cat", "content", "", "src", {
      valid_from: now - 20_000,
      valid_to: now - 10_000,
    });
    const { items, total } = db.listSharedActive();
    expect(items.length).toBe(0);
    expect(total).toBe(0);
  });

  test("recentActiveSharedForCrossLayer excludes expired rows", () => {
    const db = new MemoryDB(":memory:");
    db.insertShared("s-recent", "cat", "content", "", "src", {
      valid_from: now - 20_000,
      valid_to: now - 10_000,
    });
    const rows = db.memoryRepo.recentActiveSharedForCrossLayer(10);
    expect(rows.length).toBe(0);
  });

  test("searchContext FTS excludes expired rows", () => {
    const db = new MemoryDB(":memory:");
    db.insertContext("c-fts", "hello world", "content", "", [], "agent", {
      valid_from: now - 20_000,
      valid_to: now - 10_000,
    });
    // FTS index is rebuilt on insert via trigger; small delay not needed in :memory:
    const rows = db.searchContext("hello", 10, {
      activeOnly: true,
      notStale: true,
      agentId: "agent",
    });
    expect(rows.length).toBe(0);
  });

  test("searchShared FTS excludes expired rows", () => {
    const db = new MemoryDB(":memory:");
    db.insertShared("s-fts", "hello world", "content", "", "src", {
      valid_from: now - 20_000,
      valid_to: now - 10_000,
    });
    const rows = db.searchShared("hello", 10, { activeOnly: true, notStale: true });
    expect(rows.length).toBe(0);
  });

  test("AND-OR precedence: active + notStale + temporal does not leak", () => {
    const db = new MemoryDB(":memory:");
    // Insert row that is active, not stale, but expired temporally
    db.insertContext("c-precedence", "title", "content", "", [], "agent", {
      status: "active",
      valid_from: now - 20_000,
      valid_to: now - 10_000,
    });
    // If precedence leaked (no parens around temporal), this row might return
    const rows = db.getContextMany(["c-precedence"], {
      activeOnly: true,
      notStale: true,
      agentId: "agent",
    });
    expect(rows.length).toBe(0);
  });
});
