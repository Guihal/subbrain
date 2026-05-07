/**
 * Tests for done_with_artifact MCP tool (P2-4).
 * Real registry + ToolExecutor + MemoryDB everywhere — no `as any` mocks of
 * production wiring; tool-dispatch exercises the same path as the agent loop.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { ToolExecutor } from "@subbrain/agent/mcp/executor";
import { buildRegistry, type ToolRegistry } from "@subbrain/agent/mcp/registry";
import { doneWithArtifact, isTerminated, resetTermination }
  from "@subbrain/agent/mcp/tools/pool/done-with-artifact";
import { runToolCall } from "@subbrain/agent/pipeline/agent-loop/tool-dispatch";
import type { ToolRunnerDeps } from "@subbrain/agent/pipeline/agent-loop/tool-runner";
import { MemoryDB } from "@subbrain/core/db";
import { logger } from "@subbrain/core/lib/logger";
import type { ModelRouter } from "@subbrain/core/lib/model-router";

const DB_PATH = "data/test-done-with-artifact.db";
let db: MemoryDB;
let executor: ToolExecutor;
let registry: ToolRegistry;

const stubRouter = {
  chat: async () => ({ choices: [{ message: { content: "" } }] }),
  chatStream: () => new ReadableStream(),
  scheduleRaw: async (_p: string, fn: () => Promise<unknown>) => fn(),
  raw: { embed: async () => ({ data: [] }), rerank: async () => ({ results: [] }) },
  isOverloaded: false,
} as unknown as ModelRouter;
const dataOf = (r: unknown) => (r as { data: Record<string, unknown> }).data;
const codeOf = (r: unknown) => (r as { error: { code: string } }).error.code;

beforeAll(() => {
  if (existsSync(DB_PATH)) unlinkSync(DB_PATH);
  db = new MemoryDB(DB_PATH);
  executor = new ToolExecutor(db, stubRouter);
  registry = buildRegistry();
});

afterAll(() => {
  db.close();
  if (existsSync(DB_PATH)) unlinkSync(DB_PATH);
});

describe("done_with_artifact validation", () => {
  beforeEach(() => resetTermination());

  test("complete with artifact → success", () => {
    const r = doneWithArtifact({ status: "complete", artifact: "result.json" });
    expect(r.success).toBe(true);
    expect(dataOf(r)).toEqual({ status: "complete", artifact: "result.json" });
    expect(isTerminated()).toBe(true);
  });
  test("noop without artifact/reason → success", () => {
    const r = doneWithArtifact({ status: "noop" });
    expect(r.success).toBe(true);
    expect(dataOf(r)).toEqual({ status: "noop" });
    expect(isTerminated()).toBe(true);
  });
  test("failed with reason → success", () => {
    const r = doneWithArtifact({ status: "failed", reason: "network error" });
    expect(r.success).toBe(true);
    expect(dataOf(r)).toEqual({ status: "failed", reason: "network error" });
    expect(isTerminated()).toBe(true);
  });
  test("complete without artifact → rejected", () => {
    const r = doneWithArtifact({ status: "complete" });
    expect(r.success).toBe(false);
    expect(codeOf(r)).toBe("missing_artifact");
    expect(isTerminated()).toBe(false);
  });
  test("complete with empty artifact → rejected", () => {
    const r = doneWithArtifact({ status: "complete", artifact: "   " });
    expect(r.success).toBe(false);
    expect(codeOf(r)).toBe("missing_artifact");
  });
  test("failed without reason → rejected", () => {
    const r = doneWithArtifact({ status: "failed" });
    expect(r.success).toBe(false);
    expect(codeOf(r)).toBe("missing_reason");
    expect(isTerminated()).toBe(false);
  });
  test("failed with empty reason → rejected", () => {
    const r = doneWithArtifact({ status: "failed", reason: "" });
    expect(r.success).toBe(false);
    expect(codeOf(r)).toBe("missing_reason");
  });
  test("second invocation → already_terminated", () => {
    doneWithArtifact({ status: "noop" });
    const r = doneWithArtifact({ status: "noop" });
    expect(r.success).toBe(false);
    expect(codeOf(r)).toBe("already_terminated");
  });
});

describe("done_with_artifact registry integration", () => {
  test("tool registered with agent-only scope", () => {
    const tool = registry.get("done_with_artifact");
    expect(tool).toBeDefined();
    expect(tool?.scope).toBe("agent-only");
    expect(tool?.name).toBe("done_with_artifact");
  });

  test("public listing excludes done_with_artifact", () => {
    expect(registry.listPublic().map((t) => t.name)).not.toContain("done_with_artifact");
  });

  test("agent listing includes done_with_artifact", () => {
    expect(registry.listForAgent("interactive").map((t) => t.name)).toContain(
      "done_with_artifact",
    );
  });
});

describe("done_with_artifact tool-dispatch integration", () => {
  beforeEach(() => resetTermination());

  test("runToolCall detects isDone via real registry path", async () => {
    const dynamicTools = {
      getAll: () => ({}),
      get: () => null,
      list: () => [],
      register: () => ({ success: true }),
      delete: () => {},
    } as unknown as ToolRunnerDeps["dynamicTools"];
    const deps: ToolRunnerDeps = {
      registry, tools: executor, router: stubRouter, room: null, dynamicTools,
      persistDynamicTools: () => {}, codeTools: null, agentId: null, agentMode: "interactive",
      session: {
        consultSpecialistsCount: 0, consultSpecialistsMax: 5,
        consultChaosCount: 0, consultChaosMax: 5,
      },
    };
    const outcome = await runToolCall(
      {
        id: "call_1",
        type: "function",
        function: {
          name: "done_with_artifact",
          arguments: JSON.stringify({ status: "complete", artifact: "x" }),
        },
      },
      deps,
      logger.forRequest("test-req", "test-sess"),
    );
    expect(outcome.isDone).toBe(true);
    expect(outcome.toolResult).toContain("complete");
    expect(outcome.toolResult).toContain("x");
  });
});
