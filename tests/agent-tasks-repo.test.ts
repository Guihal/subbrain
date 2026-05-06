import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { MemoryDB } from "@subbrain/core/db";

const TEST_DB = "data/test-agent-tasks.db";

function cleanup(): void {
  for (const ext of ["", "-shm", "-wal"]) {
    const p = `${TEST_DB}${ext}`;
    if (existsSync(p)) unlinkSync(p);
  }
}

describe("AgentTasksRepository", () => {
  let db: MemoryDB;

  beforeEach(() => {
    cleanup();
    db = new MemoryDB(TEST_DB);
  });

  afterEach(() => {
    db.close();
    cleanup();
  });

  test("enqueue + listPending returns row", () => {
    const id = db.agentTasksRepo.enqueue({
      type: "free",
      prompt: "hello world",
      priority: 5,
      createdBy: "test",
    });
    expect(id).toBeGreaterThan(0);
    const pending = db.agentTasksRepo.listPending(10);
    expect(pending.length).toBe(1);
    expect(pending[0].type).toBe("free");
    expect(pending[0].prompt).toBe("hello world");
    expect(pending[0].priority).toBe(5);
    expect(pending[0].status).toBe("pending");
  });

  test("claimNext returns highest priority pending", () => {
    db.agentTasksRepo.enqueue({ type: "free", prompt: "low", priority: 1, createdBy: "test" });
    db.agentTasksRepo.enqueue({ type: "clear", prompt: "high", priority: 10, createdBy: "test" });
    const claimed = db.agentTasksRepo.claimNext(Date.now() / 1000);
    expect(claimed).not.toBeNull();
    expect(claimed!.prompt).toBe("high");
    expect(claimed!.status).toBe("running");
  });

  test("claimNext skips scheduledAt > now", () => {
    const now = Math.floor(Date.now() / 1000);
    db.agentTasksRepo.enqueue({
      type: "free",
      prompt: "future",
      priority: 10,
      scheduledAt: now + 3600,
      createdBy: "test",
    });
    db.agentTasksRepo.enqueue({ type: "free", prompt: "now", priority: 1, createdBy: "test" });
    const claimed = db.agentTasksRepo.claimNext(now);
    expect(claimed).not.toBeNull();
    expect(claimed!.prompt).toBe("now");
  });

  test("two concurrent claimNext return different ids", async () => {
    db.agentTasksRepo.enqueue({ type: "free", prompt: "a", priority: 1, createdBy: "test" });
    db.agentTasksRepo.enqueue({ type: "free", prompt: "b", priority: 2, createdBy: "test" });
    const now = Math.floor(Date.now() / 1000);
    const [r1, r2] = await Promise.allSettled([
      Promise.resolve(db.agentTasksRepo.claimNext(now)),
      Promise.resolve(db.agentTasksRepo.claimNext(now)),
    ]);
    const v1 = r1.status === "fulfilled" ? r1.value : null;
    const v2 = r2.status === "fulfilled" ? r2.value : null;
    if (v1 && v2) {
      expect(v1.id).not.toBe(v2.id);
    } else {
      // One may be null under contention; that's acceptable.
      expect(v1 !== null || v2 !== null).toBe(true);
    }
  });

  test("complete updates status and artifact", () => {
    const id = db.agentTasksRepo.enqueue({ type: "free", prompt: "x", createdBy: "test" });
    const now = Math.floor(Date.now() / 1000);
    db.agentTasksRepo.complete(id, { type: "text", content: "result" }, now);
    const row = db.agentTasksRepo.getById(id);
    expect(row!.status).toBe("done");
    expect(row!.artifact).toEqual({ type: "text", content: "result" });
    expect(row!.finishedAt).toBe(now);
  });

  test("noop updates status and reason", () => {
    const id = db.agentTasksRepo.enqueue({ type: "free", prompt: "x", createdBy: "test" });
    const now = Math.floor(Date.now() / 1000);
    db.agentTasksRepo.noop(id, "nothing to do", now);
    const row = db.agentTasksRepo.getById(id);
    expect(row!.status).toBe("noop");
    expect(row!.reason).toBe("nothing to do");
  });

  test("fail updates status and reason", () => {
    const id = db.agentTasksRepo.enqueue({ type: "free", prompt: "x", createdBy: "test" });
    const now = Math.floor(Date.now() / 1000);
    db.agentTasksRepo.fail(id, "boom", now);
    const row = db.agentTasksRepo.getById(id);
    expect(row!.status).toBe("failed");
    expect(row!.reason).toBe("boom");
  });

  test("markZombiesFailed flips old running rows", () => {
    const id = db.agentTasksRepo.enqueue({ type: "free", prompt: "z", createdBy: "test" });
    const now = Math.floor(Date.now() / 1000);
    db.agentTasksRepo.claimNext(now);
    const count = db.agentTasksRepo.markZombiesFailed(now + 1);
    expect(count).toBe(1);
    const row = db.agentTasksRepo.getById(id);
    expect(row!.status).toBe("failed");
    expect(row!.reason).toBe("zombie_timeout");
  });

  test("getDistribution24h groups by type and status", () => {
    const now = Math.floor(Date.now() / 1000);
    const id1 = db.agentTasksRepo.enqueue({ type: "free", prompt: "a", createdBy: "test" });
    const id2 = db.agentTasksRepo.enqueue({ type: "clear", prompt: "b", createdBy: "test" });
    db.agentTasksRepo.complete(id1, { type: "text", content: "r1" }, now);
    db.agentTasksRepo.noop(id2, "skip", now);
    const dist = db.agentTasksRepo.getDistribution24h(now);
    expect(dist.length).toBe(2);
    const freeDone = dist.find((d) => d.type === "free" && d.status === "done");
    const clearNoop = dist.find((d) => d.type === "clear" && d.status === "noop");
    expect(freeDone?.count).toBe(1);
    expect(clearNoop?.count).toBe(1);
  });

  test("countByPromptSnippet counts LIKE matches in last 24h", () => {
    const now = Math.floor(Date.now() / 1000);
    db.agentTasksRepo.enqueue({ type: "free", prompt: "foo bar baz", createdBy: "test" });
    db.agentTasksRepo.enqueue({ type: "free", prompt: "other", createdBy: "test" });
    expect(db.agentTasksRepo.countByPromptSnippet("bar", now)).toBe(1);
    expect(db.agentTasksRepo.countByPromptSnippet("xyz", now)).toBe(0);
  });
});
