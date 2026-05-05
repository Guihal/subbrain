/**
 * Stale-task pruning: open >30d and in_progress >7d are deleted directly.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { MemoryDB } from "@subbrain/core/db";
import { pruneStaleTasks } from "../src/pipeline/night-cycle/prune/stale-tasks";

const DB_PATH = "data/test-stale-prune.db";

function freshDb(): MemoryDB {
  for (const ext of ["", "-shm", "-wal"]) {
    const p = `${DB_PATH}${ext}`;
    if (existsSync(p)) unlinkSync(p);
  }
  return new MemoryDB(DB_PATH);
}

function seedTask(memory: MemoryDB, status: "open" | "in_progress", updatedAt: number): string {
  const id = randomUUID();
  memory.insertTask({ id, title: `task ${id}`, scope: "global" });
  memory.db.query(`UPDATE tasks SET status=?, updated_at=? WHERE id=?`).run(status, updatedAt, id);
  return id;
}

function countTasks(memory: MemoryDB): number {
  return (memory.db.query(`SELECT COUNT(*) AS c FROM tasks`).get() as { c: number }).c;
}

afterAll(() => {
  for (const ext of ["", "-shm", "-wal"]) {
    const p = `${DB_PATH}${ext}`;
    if (existsSync(p)) unlinkSync(p);
  }
});

describe("pruneStaleTasks", () => {
  let memory: MemoryDB;
  beforeEach(() => {
    memory = freshDb();
  });

  test("empty db → 0/0", () => {
    const r = pruneStaleTasks(memory);
    expect(r.openDeleted).toBe(0);
    expect(r.inProgressDeleted).toBe(0);
    memory.close();
  });

  test("open <3d kept, open >3d deleted (default threshold)", () => {
    const now = Math.floor(Date.now() / 1000);
    seedTask(memory, "open", now - 2 * 86400);
    seedTask(memory, "open", now - 4 * 86400);
    seedTask(memory, "open", now - 30 * 86400);
    const r = pruneStaleTasks(memory);
    expect(r.openDeleted).toBe(2);
    expect(countTasks(memory)).toBe(1);
    memory.close();
  });

  test("in_progress <3d kept, in_progress >3d deleted (default threshold)", () => {
    const now = Math.floor(Date.now() / 1000);
    seedTask(memory, "in_progress", now - 2 * 86400);
    seedTask(memory, "in_progress", now - 4 * 86400);
    const r = pruneStaleTasks(memory);
    expect(r.inProgressDeleted).toBe(1);
    expect(countTasks(memory)).toBe(1);
    memory.close();
  });

  test("env override raises threshold", () => {
    const prev = process.env.NIGHT_CYCLE_STALE_OPEN_DAYS;
    process.env.NIGHT_CYCLE_STALE_OPEN_DAYS = "30";
    try {
      const now = Math.floor(Date.now() / 1000);
      seedTask(memory, "open", now - 5 * 86400);
      seedTask(memory, "open", now - 31 * 86400);
      const r = pruneStaleTasks(memory);
      expect(r.openDeleted).toBe(1);
      expect(countTasks(memory)).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.NIGHT_CYCLE_STALE_OPEN_DAYS;
      else process.env.NIGHT_CYCLE_STALE_OPEN_DAYS = prev;
    }
    memory.close();
  });

  test("done/cancelled untouched (handled elsewhere)", () => {
    const now = Math.floor(Date.now() / 1000);
    const id = randomUUID();
    memory.insertTask({ id, title: "done", scope: "global" });
    memory.db
      .query(`UPDATE tasks SET status='done', completed_at=?, updated_at=? WHERE id=?`)
      .run(now - 100 * 86400, now - 100 * 86400, id);
    const r = pruneStaleTasks(memory);
    expect(r.openDeleted).toBe(0);
    expect(r.inProgressDeleted).toBe(0);
    expect(countTasks(memory)).toBe(1);
    memory.close();
  });
});
