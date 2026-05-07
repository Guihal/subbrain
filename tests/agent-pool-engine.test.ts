import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { installAgentPoolScheduler, runTick } from "@subbrain/agent/scheduler/agent-pool";
import { createAgentTaskPool } from "@subbrain/agent/scheduler/agent-pool/pool";
import type { PoolDeps, RunnerResult } from "@subbrain/agent/scheduler/agent-pool/types";
import { MemoryDB } from "@subbrain/core/db";

const TEST_DB = "data/test-agent-pool.db";

function cleanup(): void {
  for (const ext of ["", "-shm", "-wal"]) {
    const p = `${TEST_DB}${ext}`;
    if (existsSync(p)) unlinkSync(p);
  }
}

describe("agent-pool engine", () => {
  let db: MemoryDB;
  let logs: { level: string; message: string; meta?: Record<string, unknown> }[];

  beforeEach(() => {
    cleanup();
    db = new MemoryDB(TEST_DB);
    logs = [];
  });

  afterEach(() => {
    db.close();
    cleanup();
  });

  function makeLog(): PoolDeps["log"] {
    return {
      info: (_msg, extra) => {
        const meta = extra?.meta as Record<string, unknown> | undefined;
        logs.push({ level: "info", message: _msg, meta });
      },
      warn: (_msg, extra) => {
        const meta = extra?.meta as Record<string, unknown> | undefined;
        logs.push({ level: "warn", message: _msg, meta });
      },
      error: (_msg, extra) => {
        const meta = extra?.meta as Record<string, unknown> | undefined;
        logs.push({ level: "error", message: _msg, meta });
      },
    };
  }

  function makeDeps(runFn: PoolDeps["runFn"], overloaded = false): PoolDeps {
    return {
      pool: createAgentTaskPool(db.agentTasksRepo),
      router: { isOverloaded: overloaded },
      log: makeLog(),
      runFn,
    };
  }

  test("tick claims task and persists complete", async () => {
    db.agentTasksRepo.enqueue({ type: "free", prompt: "do it", createdBy: "test" });
    const deps = makeDeps(async () => ({
      status: "complete",
      artifact: { type: "text", content: "ok" },
    }));
    await runTick(deps);
    const row = db.agentTasksRepo.listPending(10);
    expect(row.length).toBe(0);
    const all = db.agentTasksRepo.getDistribution24h(Math.floor(Date.now() / 1000) + 1);
    expect(all.length).toBe(1);
    expect(all[0].status).toBe("done");
  });

  test("tick persists noop", async () => {
    db.agentTasksRepo.enqueue({ type: "free", prompt: "do it", createdBy: "test" });
    const deps = makeDeps(async () => ({ status: "noop", reason: "nothing to do" }));
    await runTick(deps);
    const all = db.agentTasksRepo.getDistribution24h(Math.floor(Date.now() / 1000) + 1);
    expect(all[0].status).toBe("noop");
  });

  test("tick persists failed on runFn throw", async () => {
    db.agentTasksRepo.enqueue({ type: "free", prompt: "do it", createdBy: "test" });
    const deps = makeDeps(async () => {
      throw new Error("boom");
    });
    await runTick(deps);
    const all = db.agentTasksRepo.getDistribution24h(Math.floor(Date.now() / 1000) + 1);
    expect(all[0].status).toBe("failed");
  });

  test("tick persists failed on explicit failed result", async () => {
    db.agentTasksRepo.enqueue({ type: "free", prompt: "do it", createdBy: "test" });
    const deps = makeDeps(async () => ({ status: "failed", reason: "bad input" }));
    await runTick(deps);
    const all = db.agentTasksRepo.getDistribution24h(Math.floor(Date.now() / 1000) + 1);
    expect(all[0].status).toBe("failed");
  });

  test("tick skips when router overloaded", async () => {
    db.agentTasksRepo.enqueue({ type: "free", prompt: "do it", createdBy: "test" });
    const deps = makeDeps(
      async () => ({ status: "complete", artifact: { type: "text", content: "ok" } }),
      true,
    );
    await runTick(deps);
    const row = db.agentTasksRepo.listPending(10);
    expect(row.length).toBe(1);
    expect(logs.some((l) => l.message === "router overloaded, skip")).toBe(true);
  });

  test("tick returns early when no pending tasks", async () => {
    const deps = makeDeps(async () => ({
      status: "complete",
      artifact: { type: "text", content: "ok" },
    }));
    await runTick(deps);
    expect(logs.some((l) => l.message === "no pending tasks")).toBe(true);
  });

  test("zombie recovery marks old running tasks failed", async () => {
    const id = db.agentTasksRepo.enqueue({ type: "free", prompt: "z", createdBy: "test" });
    const now = Math.floor(Date.now() / 1000);
    db.agentTasksRepo.claimNext(now);
    // Manually age the started_at so tick sees it as zombie
    db.db.query("UPDATE agent_tasks SET started_at = ? WHERE id = ?").run(now - 2000, id);
    const deps = makeDeps(async () => ({
      status: "complete",
      artifact: { type: "text", content: "ok" },
    }));
    await runTick(deps);
    const row = db.agentTasksRepo.getById(id);
    expect(row?.status).toBe("failed");
    expect(row?.reason).toBe("zombie_timeout");
    expect(logs.some((l) => l.message === "zombies marked failed")).toBe(true);
  });

  test("re-entrancy guard: second tick skipped while first running", async () => {
    let resolveRun: (() => void) | null = null;
    db.agentTasksRepo.enqueue({ type: "free", prompt: "slow", createdBy: "test" });
    db.agentTasksRepo.enqueue({ type: "free", prompt: "fast", createdBy: "test" });

    let started = false;
    const runFn = async (): Promise<RunnerResult> => {
      if (!started) {
        started = true;
        return new Promise((resolve) => {
          resolveRun = () => resolve({ status: "noop", reason: "resolved" });
        });
      }
      return { status: "noop", reason: "second" };
    };

    const scheduler = installAgentPoolScheduler({
      agentTasksRepo: db.agentTasksRepo,
      router: { isOverloaded: false },
      runFn,
      intervalMs: 50,
    });

    // Wait for first tick to claim and block inside runFn
    while (!started) {
      await new Promise((r) => setTimeout(r, 10));
    }
    // First tick claimed one task and is blocked inside runFn
    const pending = db.agentTasksRepo.listPending(10);
    expect(pending.length).toBe(1);

    resolveRun?.();
    await new Promise((r) => setTimeout(r, 200));
    // After resolve, second tick should claim the remaining task
    const pending2 = db.agentTasksRepo.listPending(10);
    expect(pending2.length).toBe(0);

    scheduler.stop();
  });

  test("installAgentPoolScheduler returns stop handle", () => {
    const scheduler = installAgentPoolScheduler({
      agentTasksRepo: db.agentTasksRepo,
      router: { isOverloaded: false },
      runFn: async () => ({ status: "noop", reason: "test" }),
      intervalMs: 60_000,
    });
    expect(typeof scheduler.stop).toBe("function");
    scheduler.stop();
  });
});
