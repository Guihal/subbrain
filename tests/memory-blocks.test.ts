import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { migrate } from "../packages/core/src/db/schema";
import * as blocks from "../packages/core/src/db/tables/memory/blocks";

function freshDb(): Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

describe("memory_blocks CRUD", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  test("insert + get round-trip", () => {
    blocks.insertBlock(db, "b1", "teamlead", "persona", "Be direct.");
    const row = blocks.getBlock(db, "b1");
    expect(row).not.toBeNull();
    expect(row?.owner_role).toBe("teamlead");
    expect(row?.label).toBe("persona");
    expect(row?.body).toBe("Be direct.");
    expect(row?.version).toBe(1);
  });

  test("getBlockByLabel finds row", () => {
    blocks.insertBlock(db, "b2", "coder", "style", "Use strict TS.");
    const row = blocks.getBlockByLabel(db, "coder", "style");
    expect(row).not.toBeNull();
    expect(row?.body).toBe("Use strict TS.");
  });

  test("update bumps version and body", () => {
    blocks.insertBlock(db, "b3", "critic", "tone", "Harsh.");
    blocks.updateBlock(db, "b3", { body: "Gentle." });
    const row = blocks.getBlock(db, "b3");
    expect(row?.body).toBe("Gentle.");
    expect(row?.version).toBe(2);
    expect(row?.updated_at).toBeGreaterThanOrEqual(row?.created_at ?? 0);
  });

  test("listBlocks returns ordered rows", () => {
    blocks.insertBlock(db, "b4", "teamlead", "a", "A");
    blocks.insertBlock(db, "b5", "teamlead", "b", "B");
    const rows = blocks.listBlocks(db, 10, 0);
    expect(rows.length).toBe(2);
  });

  test("listBlocksByRole filters by owner", () => {
    blocks.insertBlock(db, "b6", "memory", "x", "X");
    blocks.insertBlock(db, "b7", "flash", "y", "Y");
    const rows = blocks.listBlocksByRole(db, "memory");
    expect(rows.length).toBe(1);
    expect(rows[0].label).toBe("x");
  });

  test("countBlocks", () => {
    expect(blocks.countBlocks(db)).toBe(0);
    blocks.insertBlock(db, "b8", "generalist", "z", "Z");
    expect(blocks.countBlocks(db)).toBe(1);
  });

  test("deleteBlock removes row", () => {
    blocks.insertBlock(db, "b9", "chaos", "q", "Q");
    blocks.deleteBlock(db, "b9");
    expect(blocks.getBlock(db, "b9")).toBeNull();
  });

  test("unique constraint on (owner_role, label)", () => {
    blocks.insertBlock(db, "b10", "teamlead", "persona", "A");
    expect(() => blocks.insertBlock(db, "b11", "teamlead", "persona", "B")).toThrow();
  });

  test("same label allowed across roles", () => {
    blocks.insertBlock(db, "b12", "teamlead", "persona", "A");
    blocks.insertBlock(db, "b13", "coder", "persona", "B");
    expect(blocks.getBlockByLabel(db, "coder", "persona")?.body).toBe("B");
  });

  test("user_version is 18 after migrate", () => {
    const v = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
    expect(v?.user_version).toBe(18);
  });
});
