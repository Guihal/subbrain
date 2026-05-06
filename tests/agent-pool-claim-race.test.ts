import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { MemoryDB } from "@subbrain/core/db";

const TEST_DB = "data/test-agent-pool-claim-race.db";

function cleanup(): void {
  for (const ext of ["", "-shm", "-wal"]) {
    const p = `${TEST_DB}${ext}`;
    if (existsSync(p)) unlinkSync(p);
  }
}

describe("agent-pool claim race", () => {
  let db: MemoryDB;

  beforeEach(() => {
    cleanup();
    db = new MemoryDB(TEST_DB);
  });

  afterEach(() => {
    db.close();
    cleanup();
  });

  test("atomic claim prevents double winner over 50 iterations", async () => {
    for (let i = 0; i < 50; i++) {
      const id = db.agentTasksRepo.enqueue({ type: "free", prompt: `task-${i}`, createdBy: "test" });
      const now = Math.floor(Date.now() / 1000);

      const [c1, c2] = await Promise.all([
        Promise.resolve().then(() => db.agentTasksRepo.claim(id, now)),
        Promise.resolve().then(() => db.agentTasksRepo.claim(id, now)),
      ]);

      const winners = [c1, c2].filter(Boolean);
      expect(winners.length).toBe(1);
      expect(winners[0]!.id).toBe(id);
      expect(winners[0]!.status).toBe("running");

      const row = db.agentTasksRepo.getById(id);
      expect(row!.status).toBe("running");
    }
  });

  test("claim returns null when already running", () => {
    const id = db.agentTasksRepo.enqueue({ type: "free", prompt: "x", createdBy: "test" });
    const now = Math.floor(Date.now() / 1000);

    const first = db.agentTasksRepo.claim(id, now);
    expect(first).not.toBeNull();

    const second = db.agentTasksRepo.claim(id, now);
    expect(second).toBeNull();
  });

  test("claim returns null when already done", () => {
    const id = db.agentTasksRepo.enqueue({ type: "free", prompt: "x", createdBy: "test" });
    const now = Math.floor(Date.now() / 1000);

    const first = db.agentTasksRepo.claim(id, now);
    expect(first).not.toBeNull();

    db.agentTasksRepo.complete(id, { type: "text", content: "ok" }, now + 1);

    const second = db.agentTasksRepo.claim(id, now + 2);
    expect(second).toBeNull();
  });

  test("peekNextPending does not mutate status", () => {
    db.agentTasksRepo.enqueue({ type: "free", prompt: "a", createdBy: "test" });
    const now = Math.floor(Date.now() / 1000);

    const peeked = db.agentTasksRepo.peekNextPending(now);
    expect(peeked).not.toBeNull();
    expect(peeked!.status).toBe("pending");

    const again = db.agentTasksRepo.peekNextPending(now);
    expect(again).not.toBeNull();
    expect(again!.status).toBe("pending");

    const pending = db.agentTasksRepo.listPending(10);
    expect(pending.length).toBe(1);
    expect(pending[0].status).toBe("pending");
  });
});
