import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { installAgentPoolScheduler, runTick } from "@subbrain/agent/scheduler/agent-pool";
import { createAgentTaskPool } from "@subbrain/agent/scheduler/agent-pool/pool";
import type { PoolDeps, RunnerResult } from "@subbrain/agent/scheduler/agent-pool/types";
import { RunnerSlots } from "@subbrain/agent/scheduler/agent-pool/pool/concurrency";
import { MemoryDB } from "@subbrain/core/db";

const TEST_DB = "data/test-agent-pool-concurrency.db";

function cleanup(): void {
  for (const ext of ["", "-shm", "-wal"]) {
    const p = `${TEST_DB}${ext}`;
    if (existsSync(p)) unlinkSync(p);
  }
}

describe("agent-pool concurrency", () => {
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

  function makeDeps(runFn: PoolDeps["runFn"], maxConcurrent = 3, overloaded = false): PoolDeps {
    return {
      pool: createAgentTaskPool(db.agentTasksRepo),
      router: { isOverloaded: overloaded },
      log: makeLog(),
      runFn,
      slots: new RunnerSlots(maxConcurrent),
    };
  }

  test("dispatches up to maxConcurrent tasks in parallel", async () => {
    db.agentTasksRepo.enqueue({ type: "free", prompt: "a", createdBy: "test" });
    db.agentTasksRepo.enqueue({ type: "free", prompt: "b", createdBy: "test" });
    db.agentTasksRepo.enqueue({ type: "free", prompt: "c", createdBy: "test" });

    let running = 0;
    let maxRunning = 0;

    const runFn = async (): Promise<RunnerResult> => {
      running++;
      if (running > maxRunning) maxRunning = running;
      await new Promise((r) => setTimeout(r, 50));
      running--;
      return { status: "noop", reason: "ok" };
    };

    await runTick(makeDeps(runFn, 3));
    expect(maxRunning).toBe(3);
  });

  test("respects per-type slot limit", async () => {
    db.agentTasksRepo.enqueue({ type: "free", prompt: "a", createdBy: "test" });
    db.agentTasksRepo.enqueue({ type: "free", prompt: "b", createdBy: "test" });
    db.agentTasksRepo.enqueue({ type: "clear", prompt: "c", createdBy: "test" });

    let runningFree = 0;
    let maxRunningFree = 0;

    const runFn = async (task: import("@subbrain/core/db/tables/agent-tasks/types").AgentTaskRecord): Promise<RunnerResult> => {
      if (task.type === "free") {
        runningFree++;
        if (runningFree > maxRunningFree) maxRunningFree = runningFree;
        await new Promise((r) => setTimeout(r, 50));
        runningFree--;
      } else {
        await new Promise((r) => setTimeout(r, 50));
      }
      return { status: "noop", reason: "ok" };
    };

    // maxConcurrent=2, so free tasks can run 2 at a time, scheduled 1
    await runTick(makeDeps(runFn, 2));
    expect(maxRunningFree).toBe(2);
  });

  test("sequential fallback when slots absent", async () => {
    db.agentTasksRepo.enqueue({ type: "free", prompt: "a", createdBy: "test" });
    db.agentTasksRepo.enqueue({ type: "free", prompt: "b", createdBy: "test" });

    let running = 0;
    let maxRunning = 0;

    const runFn = async (): Promise<RunnerResult> => {
      running++;
      if (running > maxRunning) maxRunning = running;
      await new Promise((r) => setTimeout(r, 30));
      running--;
      return { status: "noop", reason: "ok" };
    };

    const deps: PoolDeps = {
      pool: createAgentTaskPool(db.agentTasksRepo),
      router: { isOverloaded: false },
      log: makeLog(),
      runFn,
      // no slots
    };

    await runTick(deps);
    expect(maxRunning).toBe(1);
  });

  test("releases slot on runFn throw", async () => {
    db.agentTasksRepo.enqueue({ type: "free", prompt: "a", createdBy: "test" });
    db.agentTasksRepo.enqueue({ type: "free", prompt: "b", createdBy: "test" });

    let callCount = 0;
    const runFn = async (): Promise<RunnerResult> => {
      callCount++;
      if (callCount === 1) throw new Error("boom");
      return { status: "noop", reason: "ok" };
    };

    await runTick(makeDeps(runFn, 2));
    const pending = db.agentTasksRepo.listPending(10);
    expect(pending.length).toBe(0);
  });

  test("installAgentPoolScheduler passes slots", async () => {
    db.agentTasksRepo.enqueue({ type: "free", prompt: "a", createdBy: "test" });

    const scheduler = installAgentPoolScheduler({
      agentTasksRepo: db.agentTasksRepo,
      router: { isOverloaded: false },
      runFn: async () => ({ status: "noop", reason: "ok" }),
      intervalMs: 60_000,
    });

    expect(typeof scheduler.stop).toBe("function");
    scheduler.stop();
  });
});
