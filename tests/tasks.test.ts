/**
 * Phase 1 Task Store — TasksTable CRUD, upsertBySource idempotency,
 * transition matrix, DB CHECK invariant, ordering.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { MemoryDB } from "../src/db";
import {
  canTransition,
  InvalidTransitionError,
  TERMINAL_STATUSES,
} from "../src/db/tables/task-transitions";

const DB_PATH = "data/test-tasks.db";

function freshDb(): MemoryDB {
  for (const ext of ["", "-shm", "-wal"]) {
    const p = `${DB_PATH}${ext}`;
    if (existsSync(p)) unlinkSync(p);
  }
  return new MemoryDB(DB_PATH);
}

describe("TasksTable — CRUD", () => {
  let memory: MemoryDB;

  beforeEach(() => {
    memory = freshDb();
  });
  afterEach(() => memory.close());

  test("insert + get round-trip", () => {
    const id = randomUUID();
    const row = memory.insertTask({
      id,
      title: "Buy milk",
      description: "2L",
      scope: "global",
      priority: 3,
      due_at: 1_800_000_000,
    });
    expect(row.id).toBe(id);
    expect(row.title).toBe("Buy milk");
    expect(row.status).toBe("open");
    expect(row.completed_at).toBeNull();
    expect(row.priority).toBe(3);
    const fetched = memory.getTask(id);
    expect(fetched?.title).toBe("Buy milk");
  });

  test("list filters by scope + status=active", () => {
    memory.insertTask({
      id: randomUUID(),
      title: "a1",
      scope: "autonomous",
    });
    memory.insertTask({ id: randomUUID(), title: "g1", scope: "global" });
    const done = memory.insertTask({
      id: randomUUID(),
      title: "g2",
      scope: "global",
    });
    memory.transitionTask(done.id, "done");
    const auto = memory.listTasks({
      scope: "autonomous",
      status: "active",
      limit: 10,
      offset: 0,
    });
    expect(auto.total).toBe(1);
    expect(auto.items[0]?.title).toBe("a1");
    const globalActive = memory.listTasks({
      scope: "global",
      status: "active",
      limit: 10,
      offset: 0,
    });
    expect(globalActive.total).toBe(1);
    expect(globalActive.items[0]?.title).toBe("g1");
  });

  test("update patches fields, no status change", () => {
    const row = memory.insertTask({
      id: randomUUID(),
      title: "old",
      scope: "global",
    });
    const upd = memory.updateTask(row.id, { title: "new", priority: 7 });
    expect(upd?.title).toBe("new");
    expect(upd?.priority).toBe(7);
    expect(upd?.status).toBe("open");
  });

  test("delete removes row", () => {
    const row = memory.insertTask({
      id: randomUUID(),
      title: "doomed",
      scope: "global",
    });
    expect(memory.deleteTask(row.id)).toBe(true);
    expect(memory.getTask(row.id)).toBeNull();
  });
});

describe("canTransition matrix", () => {
  test("allowed transitions", () => {
    expect(canTransition("open", "in_progress")).toBe(true);
    expect(canTransition("open", "done")).toBe(true);
    expect(canTransition("open", "cancelled")).toBe(true);
    expect(canTransition("in_progress", "done")).toBe(true);
    expect(canTransition("in_progress", "cancelled")).toBe(true);
    expect(canTransition("open", "open")).toBe(true); // idempotent
    expect(canTransition("in_progress", "in_progress")).toBe(true);
  });

  test("illegal transitions", () => {
    expect(canTransition("done", "open")).toBe(false);
    expect(canTransition("done", "in_progress")).toBe(false);
    expect(canTransition("cancelled", "open")).toBe(false);
    expect(canTransition("cancelled", "done")).toBe(false);
    expect(canTransition("in_progress", "open")).toBe(false);
    expect(canTransition("done", "done")).toBe(false); // no self on terminal
  });

  test("TERMINAL_STATUSES set", () => {
    expect(TERMINAL_STATUSES.has("done")).toBe(true);
    expect(TERMINAL_STATUSES.has("cancelled")).toBe(true);
    expect(TERMINAL_STATUSES.has("open")).toBe(false);
  });
});

describe("TasksTable.transition", () => {
  let memory: MemoryDB;
  beforeEach(() => {
    memory = freshDb();
  });
  afterEach(() => memory.close());

  test("done sets completed_at", () => {
    const row = memory.insertTask({
      id: randomUUID(),
      title: "t",
      scope: "global",
    });
    const done = memory.transitionTask(row.id, "done");
    expect(done.status).toBe("done");
    expect(done.completed_at).not.toBeNull();
    expect(done.completed_at).toBeGreaterThan(0);
  });

  test("task_start idempotent (double start no-op)", () => {
    const row = memory.insertTask({
      id: randomUUID(),
      title: "t",
      scope: "global",
    });
    const first = memory.transitionTask(row.id, "in_progress");
    const second = memory.transitionTask(row.id, "in_progress");
    expect(first.status).toBe("in_progress");
    expect(second.status).toBe("in_progress");
    expect(second.updated_at).toBeGreaterThanOrEqual(first.updated_at);
  });

  test("illegal transition throws InvalidTransitionError", () => {
    const row = memory.insertTask({
      id: randomUUID(),
      title: "t",
      scope: "global",
    });
    memory.transitionTask(row.id, "done");
    expect(() => memory.transitionTask(row.id, "open")).toThrow(InvalidTransitionError);
    expect(() => memory.transitionTask(row.id, "in_progress")).toThrow(InvalidTransitionError);
  });

  test("concurrent done race — one wins, other rejected", () => {
    const row = memory.insertTask({
      id: randomUUID(),
      title: "race",
      scope: "global",
    });
    const a = (() => {
      try {
        memory.transitionTask(row.id, "done");
        return "ok";
      } catch {
        return "rejected";
      }
    })();
    const b = (() => {
      try {
        memory.transitionTask(row.id, "done");
        return "ok";
      } catch {
        return "rejected";
      }
    })();
    // bun:sqlite is sync — first wins, second hits terminal→done reject.
    expect([a, b].sort()).toEqual(["ok", "rejected"]);
  });
});

describe("TasksTable.upsertBySource", () => {
  let memory: MemoryDB;
  beforeEach(() => {
    memory = freshDb();
  });
  afterEach(() => memory.close());

  test("50 parallel upserts of same source → exactly 1 row", () => {
    const source = "tg:peer=42:msg=1";
    for (let i = 0; i < 50; i++) {
      memory.upsertTaskBySource(
        source,
        {
          scope: "tg",
          title: `msg ${i}`,
          description: `d ${i}`,
          priority: i % 3,
        },
        randomUUID(),
      );
    }
    const all = memory.listTasks({
      scope: "tg",
      status: "active",
      limit: 100,
      offset: 0,
    });
    expect(all.total).toBe(1);
    // priority should be MAX(priorities seen) = 2
    expect(all.items[0]?.priority).toBe(2);
  });

  test("upsert on terminal source → skipped=true, row unchanged", () => {
    const source = "tg:peer=1:msg=9";
    const first = memory.upsertTaskBySource(source, { scope: "tg", title: "orig" }, randomUUID());
    expect(first.created).toBe(true);
    expect(first.skipped).toBe(false);

    memory.transitionTask(first.id, "done");
    const doneRow = memory.getTask(first.id);
    const doneAt = doneRow?.completed_at;

    const second = memory.upsertTaskBySource(
      source,
      { scope: "tg", title: "new content" },
      randomUUID(),
    );
    expect(second.created).toBe(false);
    expect(second.skipped).toBe(true);
    expect(second.id).toBe(first.id);

    const after = memory.getTask(first.id);
    expect(after?.title).toBe("orig");
    expect(after?.status).toBe("done");
    expect(after?.completed_at).toBe(doneAt!);
  });

  test("upsert existing active → updates fields, keeps id", () => {
    const source = "ext:1";
    const first = memory.upsertTaskBySource(
      source,
      { scope: "global", title: "v1", priority: 1 },
      randomUUID(),
    );
    const second = memory.upsertTaskBySource(
      source,
      { scope: "global", title: "v2", priority: 5 },
      randomUUID(),
    );
    expect(second.id).toBe(first.id);
    expect(second.created).toBe(false);
    expect(second.skipped).toBe(false);
    const row = memory.getTask(first.id);
    expect(row?.title).toBe("v2");
    expect(row?.priority).toBe(5);
  });
});

describe("DB CHECK invariant", () => {
  let memory: MemoryDB;
  beforeEach(() => {
    memory = freshDb();
  });
  afterEach(() => memory.close());

  test("manual UPDATE status='done' without completed_at throws", () => {
    const row = memory.insertTask({
      id: randomUUID(),
      title: "t",
      scope: "global",
    });
    expect(() => memory.db.query(`UPDATE tasks SET status='done' WHERE id=?`).run(row.id)).toThrow(
      /CHECK/i,
    );
  });

  test("manual INSERT done without completed_at throws", () => {
    expect(() =>
      memory.db
        .query(`INSERT INTO tasks (id,title,scope,status) VALUES (?,?,'global','done')`)
        .run(randomUUID(), "x"),
    ).toThrow(/CHECK/i);
  });
});

describe("listActive ordering (priority DESC, due_at ASC NULLS LAST, id ASC)", () => {
  let memory: MemoryDB;
  beforeEach(() => {
    memory = freshDb();
  });
  afterEach(() => memory.close());

  test("priority wins over due_at, nulls last, id deterministic tie-break", () => {
    const low = memory.insertTask({
      id: "aaaa0000-0000-0000-0000-000000000001",
      title: "low",
      scope: "global",
      priority: 1,
      due_at: 100,
    });
    const high = memory.insertTask({
      id: "bbbb0000-0000-0000-0000-000000000002",
      title: "high",
      scope: "global",
      priority: 5,
      due_at: 200,
    });
    const nullDue = memory.insertTask({
      id: "cccc0000-0000-0000-0000-000000000003",
      title: "null-due",
      scope: "global",
      priority: 5,
      due_at: null,
    });
    const earlyDue = memory.insertTask({
      id: "dddd0000-0000-0000-0000-000000000004",
      title: "early",
      scope: "global",
      priority: 5,
      due_at: 50,
    });
    const order = memory.listTasksActive("global", 10).map((r) => r.title);
    // priority=5 group: earlyDue (50) < high (200) < null-due (null last)
    // then priority=1: low
    expect(order).toEqual(["early", "high", "null-due", "low"]);
    // refs silence unused warnings:
    void low;
    void nullDue;
    void earlyDue;
    void high;
  });
});

describe("listCompletedSince", () => {
  let memory: MemoryDB;
  beforeEach(() => {
    memory = freshDb();
  });
  afterEach(() => memory.close());

  test("returns only done|cancelled within window", () => {
    const t1 = memory.insertTask({
      id: randomUUID(),
      title: "t1",
      scope: "global",
    });
    memory.transitionTask(t1.id, "done");
    const t2 = memory.insertTask({
      id: randomUUID(),
      title: "t2",
      scope: "global",
    });
    memory.transitionTask(t2.id, "cancelled");
    const open = memory.insertTask({
      id: randomUUID(),
      title: "open",
      scope: "global",
    });
    void open;
    const res = memory.listCompletedTasksSince({
      sinceUnix: 0,
      limit: 10,
      offset: 0,
    });
    expect(res.total).toBe(2);
    const titles = res.items.map((r) => r.title).sort();
    expect(titles).toEqual(["t1", "t2"]);
  });
});
