/**
 * Phase 3 — rate-limit guard on task_* mutating handlers.
 *
 * Tests the Level-1 guard (tasks.tools.ts) through the public registry.call
 * surface. The hippocampus-loop integration (POST_TOOLS containing task_add,
 * registry.call dispatch) is covered by pipeline-post-hippocampus.test.ts
 * — here we pin the budget semantics themselves.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import {
  type AgentToolContext,
  buildRegistry,
  ToolExecutor,
  type ToolRegistry,
} from "@subbrain/agent/mcp";
import type { TaskMutationBudget } from "@subbrain/agent/mcp/registry";
import { MemoryDB } from "@subbrain/core/db";

const DB_PATH = "data/test-hippo-budget.db";

function freshDb(): MemoryDB {
  for (const ext of ["", "-shm", "-wal"]) {
    const p = `${DB_PATH}${ext}`;
    if (existsSync(p)) unlinkSync(p);
  }
  return new MemoryDB(DB_PATH);
}

function mkExecutor(memory: MemoryDB): ToolExecutor {
  // router stub unused by task_* handlers (pure DB ops).
  const router = {
    chat: async () => ({}),
    scheduleRaw: async (_p: string, fn: () => Promise<any>) => fn(),
    raw: {},
  } as any;
  return new ToolExecutor(memory, router);
}

async function addTask(registry: ToolRegistry, ctx: AgentToolContext, title: string) {
  return registry.callAsAgent("task_add", { title, scope: "global" }, ctx);
}

describe("Hippocampus taskBudget — registry guard", () => {
  let memory: MemoryDB;
  let executor: ToolExecutor;
  let registry: ToolRegistry;

  beforeEach(() => {
    memory = freshDb();
    executor = mkExecutor(memory);
    registry = buildRegistry();
  });
  afterEach(() => memory.close());

  test("3 task_add calls succeed; 4th returns rate_limit", async () => {
    const budget: TaskMutationBudget = { remaining: 3 };
    const ctx = { executor, taskBudget: budget } as unknown as AgentToolContext;

    const r1 = await addTask(registry, ctx, "t1");
    const r2 = await addTask(registry, ctx, "t2");
    const r3 = await addTask(registry, ctx, "t3");
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(r3.success).toBe(true);
    expect(budget.remaining).toBe(0);

    const r4 = await addTask(registry, ctx, "t4");
    expect(r4.success).toBe(false);
    expect(r4.error).toContain("rate_limit");
    expect(r4.error).toContain("3");
    // denial must not flip the counter negative.
    expect(budget.remaining).toBe(0);
  });

  test("no taskBudget in ctx → unlimited (non-hippocampus path unchanged)", async () => {
    const ctx = { executor } as unknown as AgentToolContext;
    for (let i = 0; i < 10; i++) {
      const r = await addTask(registry, ctx, `x${i}`);
      expect(r.success).toBe(true);
    }
  });

  test("budget shared across task_add/update/start/done (symmetry)", async () => {
    const budget: TaskMutationBudget = { remaining: 3 };
    const ctx = { executor, taskBudget: budget } as unknown as AgentToolContext;

    const added = await addTask(registry, ctx, "symmetry");
    expect(added.success).toBe(true);
    const taskId = (added.data as { id: string }).id;
    expect(budget.remaining).toBe(2);

    const updated = await registry.callAsAgent("task_update", { id: taskId, priority: 5 }, ctx);
    expect(updated.success).toBe(true);
    expect(budget.remaining).toBe(1);

    const started = await registry.callAsAgent("task_start", { id: taskId }, ctx);
    expect(started.success).toBe(true);
    expect(budget.remaining).toBe(0);

    const doneAttempt = await registry.callAsAgent(
      "task_done",
      { id: taskId, summary: "fin" },
      ctx,
    );
    expect(doneAttempt.success).toBe(false);
    expect(doneAttempt.error).toContain("rate_limit");
  });

  test("task_cancel also consumes the same budget", async () => {
    const budget: TaskMutationBudget = { remaining: 1 };
    const ctx = { executor, taskBudget: budget } as unknown as AgentToolContext;
    const added = await addTask(registry, { executor } as unknown as AgentToolContext, "cancel-me");
    expect(added.success).toBe(true);
    const taskId = (added.data as { id: string }).id;

    const cancelled = await registry.callAsAgent(
      "task_cancel",
      { id: taskId, reason: "nope" },
      ctx,
    );
    expect(cancelled.success).toBe(true);
    expect(budget.remaining).toBe(0);

    const extra = await registry.callAsAgent("task_cancel", { id: taskId, reason: "again" }, ctx);
    expect(extra.success).toBe(false);
    expect(extra.error).toContain("rate_limit");
  });

  test("task_list is free — does NOT consume budget even at remaining=0", async () => {
    const budget: TaskMutationBudget = { remaining: 0 };
    const ctx = { executor, taskBudget: budget } as unknown as AgentToolContext;

    const listed = await registry.callAsAgent("task_list", { scope: "global" }, ctx);
    expect(listed.success).toBe(true);
    expect(budget.remaining).toBe(0);
  });

  test("fresh TaskMutationBudget object is independent (no global state leak)", async () => {
    const a: TaskMutationBudget = { remaining: 3 };
    const b: TaskMutationBudget = { remaining: 3 };
    const ctxA = { executor, taskBudget: a } as unknown as AgentToolContext;
    const ctxB = { executor, taskBudget: b } as unknown as AgentToolContext;

    await addTask(registry, ctxA, "a1");
    await addTask(registry, ctxA, "a2");
    expect(a.remaining).toBe(1);
    expect(b.remaining).toBe(3);
    await addTask(registry, ctxB, "b1");
    expect(b.remaining).toBe(2);
    expect(a.remaining).toBe(1);
  });
});
