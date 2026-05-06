/**
 * P3-5 (mig 18): memory_blocks schema + CRUD via MemoryTable.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { MemoryDB } from "@subbrain/core/db";

const TEST_DB = "data/test-blocks.db";

function cleanup() {
  for (const ext of ["", "-shm", "-wal"]) {
    const p = `${TEST_DB}${ext}`;
    if (existsSync(p)) unlinkSync(p);
  }
}

describe("P3-5 memory_blocks (mig 18)", () => {
  let memory: MemoryDB;

  beforeAll(() => {
    cleanup();
    memory = new MemoryDB(TEST_DB);
  });

  afterAll(() => {
    memory.close();
    cleanup();
  });

  test("table + indexes exist after migration", () => {
    const tbl = memory.db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_blocks'",
      )
      .get();
    expect(tbl?.name).toBe("memory_blocks");

    const idx = memory.db
      .query<{ c: number }, []>(
        "SELECT count(*) AS c FROM sqlite_master WHERE type='index' AND name LIKE 'idx_blocks%'",
      )
      .get()?.c;
    expect(idx).toBe(2);
  });

  test("insertBlock + getBlock round-trip", () => {
    memory.insertBlock("b1", "coder", "prompt-template", "Hello {{name}}");
    const row = memory.getBlock("b1");
    expect(row).not.toBeNull();
    expect(row!.id).toBe("b1");
    expect(row!.owner_role).toBe("coder");
    expect(row!.label).toBe("prompt-template");
    expect(row!.body).toBe("Hello {{name}}");
    expect(row!.version).toBe(1);
    expect(typeof row!.created_at).toBe("number");
    expect(typeof row!.updated_at).toBe("number");
  });

  test("getBlockByLabel finds by composite key", () => {
    memory.insertBlock("b2", "teamlead", "system-preamble", "You are a team lead.");
    const row = memory.getBlockByLabel("teamlead", "system-preamble");
    expect(row).not.toBeNull();
    expect(row!.id).toBe("b2");
  });

  test("UNIQUE(owner_role, label) blocks duplicate label for same role", () => {
    memory.insertBlock("b3", "critic", "rubric", "Check for bugs.");
    expect(() => memory.insertBlock("b4", "critic", "rubric", "Different body.")).toThrow();
  });

  test("same label allowed for different roles", () => {
    memory.insertBlock("b5a", "coder", "shared-label", "A");
    memory.insertBlock("b5b", "critic", "shared-label", "B");
    expect(memory.getBlockByLabel("coder", "shared-label")!.body).toBe("A");
    expect(memory.getBlockByLabel("critic", "shared-label")!.body).toBe("B");
  });

  test("updateBlock bumps version and updated_at", () => {
    memory.insertBlock("b6", "flash", "greeting", "Hi");
    const before = memory.getBlock("b6")!;
    const ok = memory.updateBlock("b6", { body: "Hello" });
    expect(ok).toBe(true);
    const after = memory.getBlock("b6")!;
    expect(after.body).toBe("Hello");
    expect(after.version).toBe(before.version + 1);
    expect(after.updated_at).toBeGreaterThanOrEqual(before.updated_at);
  });

  test("updateBlock with empty fields is no-op", () => {
    memory.insertBlock("b7", "generalist", "note", "X");
    const ok = memory.updateBlock("b7", {});
    expect(ok).toBe(false);
  });

  test("updateBlock on missing id returns false", () => {
    const ok = memory.updateBlock("missing", { body: "Y" });
    expect(ok).toBe(false);
  });

  test("listBlocks returns ordered by updated_at DESC", () => {
    memory.insertBlock("b8", "coder", "l1", "one");
    memory.insertBlock("b9", "coder", "l2", "two");
    const rows = memory.listBlocks();
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[0].updated_at).toBeGreaterThanOrEqual(rows[1].updated_at);
  });

  test("listBlocks respects limit + offset", () => {
    memory.insertBlock("b10", "coder", "l3", "three");
    memory.insertBlock("b11", "coder", "l4", "four");
    const limited = memory.listBlocks(1);
    expect(limited.length).toBe(1);
    const offset = memory.listBlocks(1, 1);
    expect(offset.length).toBe(1);
    expect(offset[0].id).not.toBe(limited[0].id);
  });

  test("listBlocksByRole filters correctly", () => {
    memory.insertBlock("b12", "memory", "hippo-prompt", "Extract facts.");
    const rows = memory.listBlocksByRole("memory");
    expect(rows.every((r) => r.owner_role === "memory")).toBe(true);
  });

  test("countBlocks tracks inserts", () => {
    const before = memory.countBlocks();
    memory.insertBlock("b13", "chaos", "joke", "Why did the chicken...");
    expect(memory.countBlocks()).toBe(before + 1);
  });

  test("deleteBlock removes row and returns true", () => {
    memory.insertBlock("b14", "coder", "tmp", "temp");
    expect(memory.getBlock("b14")).not.toBeNull();
    const ok = memory.deleteBlock("b14");
    expect(ok).toBe(true);
    expect(memory.getBlock("b14")).toBeNull();
  });

  test("deleteBlock on missing id returns false", () => {
    const ok = memory.deleteBlock("missing-99");
    expect(ok).toBe(false);
  });
});
