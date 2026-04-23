/**
 * Phase 5 — Retention: pruneCompletedTasks unit tests + /history loader.
 *
 * Uses a fake Embedder (no network). Tasks are seeded via insertTask then
 * force-mutated into the `done`/`cancelled` state with a specific
 * completed_at, because transitionTask stamps unixepoch() — we need to
 * cover 2025 dates, week edges, etc.
 */
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { MemoryDB } from "../src/db";
import type { Embedder } from "../src/pipeline/night-cycle/prune/tasks";
import {
  _capFromTailForTest,
  pruneCompletedTasks,
} from "../src/pipeline/night-cycle/prune/tasks";
import { buildHistoryLoader } from "../src/routes/tasks";

const DB_PATH = "data/test-retention.db";

function freshDb(): MemoryDB {
  for (const ext of ["", "-shm", "-wal"]) {
    const p = `${DB_PATH}${ext}`;
    if (existsSync(p)) unlinkSync(p);
  }
  return new MemoryDB(DB_PATH);
}

function seedDoneTask(
  memory: MemoryDB,
  completedAt: number,
  opts: { scope?: string; title?: string; description?: string } = {},
): string {
  const id = randomUUID();
  memory.insertTask({
    id,
    title: opts.title ?? "done task",
    description: opts.description ?? "",
    scope: (opts.scope as "global") ?? "global",
  });
  memory.db
    .query(
      `UPDATE tasks SET status='done', completed_at=?, updated_at=? WHERE id=?`,
    )
    .run(completedAt, completedAt, id);
  return id;
}

function seedCancelledTask(memory: MemoryDB, updatedAt: number): string {
  const id = randomUUID();
  memory.insertTask({ id, title: "cancel me", scope: "global" });
  memory.db
    .query(
      `UPDATE tasks SET status='cancelled', completed_at=?, updated_at=? WHERE id=?`,
    )
    .run(updatedAt, updatedAt, id);
  return id;
}

function countArchive(memory: MemoryDB, tagLike: string): number {
  return (
    memory.db
      .query(
        `SELECT COUNT(*) AS c FROM layer3_archive WHERE tags LIKE ?`,
      )
      .get(tagLike) as { c: number }
  ).c;
}

function makeEmbedder(): Embedder & { calls: number; lastContent: string } {
  const state = { calls: 0, lastContent: "" };
  return {
    calls: 0,
    lastContent: "",
    async embedContent(c: string) {
      state.calls += 1;
      state.lastContent = c;
      this.calls = state.calls;
      this.lastContent = state.lastContent;
      return new Float32Array(2048);
    },
  };
}

afterAll(() => {
  for (const ext of ["", "-shm", "-wal"]) {
    const p = `${DB_PATH}${ext}`;
    if (existsSync(p)) unlinkSync(p);
  }
});

describe("pruneCompletedTasks", () => {
  let memory: MemoryDB;

  beforeEach(() => {
    memory = freshDb();
  });

  test("0 done>7d → pruned=0, no archive rows", async () => {
    const emb = makeEmbedder();
    const pruned = await pruneCompletedTasks(memory, emb);
    expect(pruned).toBe(0);
    expect(countArchive(memory, "tasks,digest,%")).toBe(0);
    expect(emb.calls).toBe(0);
    memory.close();
  });

  test("5 done same week → 1 archive, 5 tasks deleted, pruned=5, embed 1x", async () => {
    const now = Math.floor(Date.now() / 1000);
    const tenDaysAgo = now - 10 * 86400;
    for (let i = 0; i < 5; i++) {
      seedDoneTask(memory, tenDaysAgo + i * 60, { title: `t${i}` });
    }
    const emb = makeEmbedder();
    const pruned = await pruneCompletedTasks(memory, emb);
    expect(pruned).toBe(5);
    expect(emb.calls).toBe(1);
    expect(countArchive(memory, "tasks,digest,%")).toBe(1);
    const remaining = memory.db
      .query(`SELECT COUNT(*) AS c FROM tasks`)
      .get() as { c: number };
    expect(remaining.c).toBe(0);
    memory.close();
  });

  test("3 different weeks → 3 archive entries", async () => {
    const now = Math.floor(Date.now() / 1000);
    seedDoneTask(memory, now - 10 * 86400);
    seedDoneTask(memory, now - 20 * 86400);
    seedDoneTask(memory, now - 30 * 86400);
    const emb = makeEmbedder();
    const pruned = await pruneCompletedTasks(memory, emb);
    expect(pruned).toBe(3);
    expect(countArchive(memory, "tasks,digest,%")).toBe(3);
    expect(emb.calls).toBe(3);
    memory.close();
  });

  test("existing digest same week → updateArchive appends, count stays 1", async () => {
    const now = Math.floor(Date.now() / 1000);
    const tenDaysAgo = now - 10 * 86400;
    seedDoneTask(memory, tenDaysAgo, { title: "first-batch-task" });
    const emb = makeEmbedder();
    await pruneCompletedTasks(memory, emb);
    expect(countArchive(memory, "tasks,digest,%")).toBe(1);

    seedDoneTask(memory, tenDaysAgo + 3600, { title: "second-batch-task" });
    await pruneCompletedTasks(memory, emb);
    expect(countArchive(memory, "tasks,digest,%")).toBe(1);
    const row = memory.db
      .query(
        `SELECT content FROM layer3_archive WHERE tags LIKE 'tasks,digest,%' LIMIT 1`,
      )
      .get() as { content: string };
    expect(row.content).toInclude("first-batch-task");
    expect(row.content).toInclude("second-batch-task");
    memory.close();
  });

  test("prefix-collision safe: 2026-w1 digest is not matched by w10 lookup", async () => {
    // Seed a digest for 2026-w1 manually, then prune tasks in 2026-w10 → must
    // create new row, NOT update the w1 row.
    const w1 = "tasks,digest,2026-w01";
    memory.insertArchive(
      "fixed-w1-id",
      "seed",
      "old w1 content",
      w1,
      [],
      "HIGH",
      "night-cycle",
    );
    // A fake digest for w10 label that should not collide with w1 via LIKE.
    // Use a real completion timestamp inside week 10 (2026-03-09 UTC = Mon).
    const w10Completion = Math.floor(
      Date.UTC(2026, 2, 10, 12, 0, 0) / 1000,
    );
    seedDoneTask(memory, w10Completion);
    const emb = makeEmbedder();
    await pruneCompletedTasks(memory, emb);
    const w1Content = memory.db
      .query(`SELECT content FROM layer3_archive WHERE id='fixed-w1-id'`)
      .get() as { content: string };
    expect(w1Content.content).toBe("old w1 content");
    expect(countArchive(memory, "tasks,digest,%")).toBe(2);
    memory.close();
  });

  test("embed throws → tasks remain, no archive for failing week", async () => {
    const now = Math.floor(Date.now() / 1000);
    seedDoneTask(memory, now - 10 * 86400);
    const emb: Embedder = {
      async embedContent() {
        throw new Error("embed down");
      },
    };
    const pruned = await pruneCompletedTasks(memory, emb);
    expect(pruned).toBe(0);
    const remaining = memory.db
      .query(`SELECT COUNT(*) AS c FROM tasks`)
      .get() as { c: number };
    expect(remaining.c).toBe(1);
    expect(countArchive(memory, "tasks,digest,%")).toBe(0);
    memory.close();
  });

  test("cancelled > 1d → DELETE without digest, counted in return", async () => {
    const now = Math.floor(Date.now() / 1000);
    seedCancelledTask(memory, now - 2 * 86400);
    seedCancelledTask(memory, now - 2 * 86400);
    const emb = makeEmbedder();
    const pruned = await pruneCompletedTasks(memory, emb);
    expect(pruned).toBe(2);
    expect(countArchive(memory, "tasks,digest,%")).toBe(0);
    memory.close();
  });

  test("capFromTail: single >50KB line falls back to char truncation, not empty", () => {
    const hugeLine = "- [global] " + "x".repeat(60_000);
    const result = _capFromTailForTest(hugeLine);
    expect(result.length).toBeLessThanOrEqual(50_000);
    expect(result.length).toBeGreaterThan(40_000);
    expect(result).toStartWith("Completed ~");
  });

  test("week rollover: 2025-12-31 and 2026-01-01 go to different buckets", async () => {
    const dec31 = Math.floor(Date.UTC(2025, 11, 31, 12, 0, 0) / 1000);
    const jan01 = Math.floor(Date.UTC(2026, 0, 1, 12, 0, 0) / 1000);
    seedDoneTask(memory, dec31, { title: "old-year" });
    seedDoneTask(memory, jan01, { title: "new-year" });
    const emb = makeEmbedder();
    const pruned = await pruneCompletedTasks(memory, emb);
    expect(pruned).toBe(2);
    expect(countArchive(memory, "tasks,digest,%")).toBe(2);
    const tags = memory.db
      .query(`SELECT tags FROM layer3_archive ORDER BY tags ASC`)
      .all() as { tags: string }[];
    expect(tags.length).toBe(2);
    expect(tags[0].tags).not.toBe(tags[1].tags);
    memory.close();
  });
});

describe("history loader — strict phase pagination", () => {
  let memory: MemoryDB;

  beforeEach(() => {
    memory = freshDb();
  });

  function seedLiveDone(count: number, baseAgo: number): void {
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < count; i++) {
      const ts = now - baseAgo - i * 60;
      seedDoneTask(memory, ts, { title: `live-${i}` });
    }
  }

  function seedDigestRows(count: number): void {
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < count; i++) {
      const id = randomUUID();
      memory.insertArchive(
        id,
        `Completed tasks 2026-w${String(i).padStart(2, "0")}`,
        `- [global] digest-${i}`,
        `tasks,digest,2026-w${String(i).padStart(2, "0")}`,
        [],
        "HIGH",
        "night-cycle",
      );
      memory.db
        .query(`UPDATE layer3_archive SET created_at=? WHERE id=?`)
        .run(now - i * 60, id);
    }
  }

  test("10 live + 5 digests, limit=12 offset=0 → 10 live + 2 digests, total=15", async () => {
    seedLiveDone(10, 3600);
    seedDigestRows(5);
    const since = Math.floor(Date.now() / 1000) - 30 * 86400;
    const loader = buildHistoryLoader(memory, undefined, since);
    const res = loader(12, 0);
    expect(res.total).toBe(15);
    const taskItems = res.items.filter((x) => x.kind === "task");
    const digestItems = res.items.filter((x) => x.kind === "digest");
    expect(taskItems.length).toBe(10);
    expect(digestItems.length).toBe(2);
    memory.close();
  });

  test("limit=5 offset=12 → 0 live + 3 digests, total=15", async () => {
    seedLiveDone(10, 3600);
    seedDigestRows(5);
    const since = Math.floor(Date.now() / 1000) - 30 * 86400;
    const loader = buildHistoryLoader(memory, undefined, since);
    const res = loader(5, 12);
    expect(res.total).toBe(15);
    const taskItems = res.items.filter((x) => x.kind === "task");
    const digestItems = res.items.filter((x) => x.kind === "digest");
    expect(taskItems.length).toBe(0);
    expect(digestItems.length).toBe(3);
    memory.close();
  });

  test("limit=10 offset=15 → empty page, total=15", async () => {
    seedLiveDone(10, 3600);
    seedDigestRows(5);
    const since = Math.floor(Date.now() / 1000) - 30 * 86400;
    const loader = buildHistoryLoader(memory, undefined, since);
    const res = loader(10, 15);
    expect(res.total).toBe(15);
    expect(res.items.length).toBe(0);
    memory.close();
  });
});
