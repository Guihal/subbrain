import { describe, expect, test } from "bun:test";
import { HooksDispatcher } from "@subbrain/agent/hooks";
import type { ToolExecutor, ToolRegistry } from "@subbrain/agent/mcp";
import type { AgentLoopSession } from "@subbrain/agent/mcp/registry/tool-registry";
import type { DynamicToolRegistry } from "@subbrain/agent/pipeline/agent-loop/dynamic-tools";
import { executeAgentTool } from "@subbrain/agent/pipeline/agent-loop/tool-runner";
import type { logger } from "@subbrain/core/lib/logger";
import type { ModelRouter } from "@subbrain/core/lib/model-router";
import type { ToolCall } from "@subbrain/providers/types";

const mockLog: ReturnType<typeof logger.forRequest> = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as ReturnType<typeof logger.forRequest>;

const mockRouter = {
  chat: async () => ({ choices: [{ message: { content: "ok" } }] }),
  chatStream: () => new ReadableStream(),
  scheduleRaw: async (_p: string, fn: () => Promise<unknown>) => fn(),
  raw: {},
  isOverloaded: false,
} as unknown as ModelRouter;

const mockRegistry = {
  has: () => false,
  callAsAgent: async () => ({ success: true, data: "" }),
} as unknown as ToolRegistry;

const mockDynamicTools = {
  getAll: () => ({}),
  get: () => null,
  list: () => [],
  register: () => ({ success: true }),
  delete: () => undefined,
} as unknown as DynamicToolRegistry;

function baseDeps() {
  return {
    registry: mockRegistry,
    tools: {} as ToolExecutor,
    router: mockRouter,
    room: null,
    dynamicTools: mockDynamicTools,
    persistDynamicTools: () => undefined,
    codeTools: null,
    session: { id: "test-session", requestId: "test-req" } as AgentLoopSession,
    agentId: null,
    agentMode: "interactive" as const,
  };
}

function tc(name: string, args: Record<string, unknown>): ToolCall {
  return {
    id: crypto.randomUUID(),
    type: "function" as const,
    function: { name, arguments: JSON.stringify(args) },
  };
}

describe("tool-runner hooks (A2-3)", () => {
  test("onToolBefore short-circuits and returns legacy JSON", async () => {
    const hooks = new HooksDispatcher();
    hooks.register({
      name: "test-reject",
      setup(api) {
        api.hooks.onToolBefore(async () => ({
          kind: "rejected" as const,
          error: { code: "test_reject", message: "nope" },
        }));
      },
    });

    const r = await executeAgentTool(
      tc("think", { thought: "x" }),
      { ...baseDeps(), hooks },
      mockLog,
    );
    expect(r).toBe(
      JSON.stringify({ success: false, error: { code: "test_reject", message: "nope" } }),
    );
  });

  test("onToolAfter observer receives the result", async () => {
    const hooks = new HooksDispatcher();
    const afterCalls: Array<{ toolName: string; resultKind: string }> = [];
    hooks.register({
      name: "test-observer",
      setup(api) {
        api.hooks.onToolAfter(({ toolName, result }) => {
          afterCalls.push({ toolName, resultKind: result.kind });
          return Promise.resolve();
        });
      },
    });

    const r = await executeAgentTool(
      tc("think", { thought: "x" }),
      { ...baseDeps(), hooks },
      mockLog,
    );
    expect(afterCalls.length).toBe(1);
    expect(afterCalls[0].toolName).toBe("think");
    expect(afterCalls[0].resultKind).toBe("failure");
    expect(JSON.parse(r).error).toContain("Unknown tool");
  });

  test("hookless path produces identical output", async () => {
    const r1 = await executeAgentTool(tc("think", { thought: "x" }), baseDeps(), mockLog);
    const r2 = await executeAgentTool(
      tc("think", { thought: "x" }),
      { ...baseDeps(), hooks: undefined },
      mockLog,
    );
    expect(r1).toBe(r2);
    expect(JSON.parse(r1).error).toContain("Unknown tool");
  });
});
