/**
 * Agent Pipeline hooks wiring tests (A2-4).
 *
 * Validates:
 * - chat.system.transform in runPre
 * - chat.params in runMain
 * - permission.ask in tool-runner
 * - hooks propagation through AgentPipeline + buildPipelineStream
 */

import { describe, expect, test } from "bun:test";
import { HooksDispatcher } from "@subbrain/agent/hooks";
import type { ToolExecutor, ToolRegistry } from "@subbrain/agent/mcp";
import type { AgentLoopSession } from "@subbrain/agent/mcp/registry/tool-registry";
import { AgentPipeline } from "@subbrain/agent/pipeline";
import type { DynamicToolRegistry } from "@subbrain/agent/pipeline/agent-loop/dynamic-tools";
import { executeAgentTool } from "@subbrain/agent/pipeline/agent-loop/tool-runner";
import { runMain } from "@subbrain/agent/pipeline/agent-pipeline/phases/main";
import { runPre } from "@subbrain/agent/pipeline/agent-pipeline/phases/pre";
import type { MemoryDB } from "@subbrain/core/db";
import type { logger } from "@subbrain/core/lib/logger";
import type { ModelRouter } from "@subbrain/core/lib/model-router";
import type { ChatResponse, ToolCall } from "@subbrain/providers/types";

// ─── Mock logger ─────────────────────────────────────────

const mockLog: ReturnType<typeof logger.forRequest> = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as ReturnType<typeof logger.forRequest>;

// ─── Mock router ─────────────────────────────────────────

const mockResponse: ChatResponse = {
  id: "test-id",
  object: "chat.completion",
  created: Date.now(),
  model: "mock",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "Mock response" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

const mockRouter = {
  chat: async () => mockResponse,
  chatStream: () => new ReadableStream(),
  scheduleRaw: async (_p: string, fn: () => Promise<unknown>) => fn(),
  raw: {},
  isOverloaded: false,
} as unknown as ModelRouter;

// ─── Mock memory ─────────────────────────────────────────

const mockMemory = {
  getAllFocus: () => ({ test: "value" }),
  getAllShared: () => [],
} as unknown as MemoryDB;

// ─── Mock RAG ────────────────────────────────────────────

const mockRag = {
  search: async () => [],
} as any;

// ─── Tool-runner mocks ───────────────────────────────────

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

function baseToolDeps() {
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

// ─── Tests ───────────────────────────────────────────────

describe("A2-4 pipeline hooks", () => {
  test("runPre applies chat.system.transform hook", async () => {
    const hooks = new HooksDispatcher();
    let capturedSystem = "";
    hooks.register({
      name: "test-transform",
      setup(api) {
        api.hooks.onChatSystemTransform(async ({ system }) => {
          capturedSystem = system;
          return `${system}\n[TRANSFORMED]`;
        });
      },
    });

    const result = await runPre({
      memory: mockMemory,
      router: mockRouter,
      rag: mockRag,
      model: "teamlead",
      userMessage: "hello",
      firstMessage: false,
      hooks,
    });

    expect(capturedSystem.length).toBeGreaterThan(0);
    expect(result.enrichedSystemPrompt).toEndWith("[TRANSFORMED]");
  });

  test("runMain applies chat.params hook", async () => {
    const hooks = new HooksDispatcher();
    let capturedParams: any = null;
    hooks.register({
      name: "test-params",
      setup(api) {
        api.hooks.onChatParams(async (params) => {
          capturedParams = params;
          return { ...params, temperature: 0.99 };
        });
      },
    });

    let chatCalledWith: any = null;
    const trackingRouter = {
      ...mockRouter,
      chat: async (_model: string, params: any) => {
        chatCalledWith = params;
        return mockResponse;
      },
    } as unknown as ModelRouter;

    await runMain({
      req: {
        model: "teamlead",
        messages: [{ role: "user", content: "hi" }],
        temperature: 0.5,
      } as any,
      router: trackingRouter,
      metrics: null,
      log: mockLog,
      hooks,
    });

    expect(capturedParams).not.toBeNull();
    expect(chatCalledWith.temperature).toBe(0.99);
  });

  test("tool-runner permission.ask denies tool execution", async () => {
    const hooks = new HooksDispatcher();
    hooks.register({
      name: "test-deny",
      setup(api) {
        api.hooks.onPermissionAsk(async ({ toolName }) => {
          return toolName !== "think";
        });
      },
    });

    const r = await executeAgentTool(
      tc("think", { thought: "x" }),
      { ...baseToolDeps(), hooks },
      mockLog,
    );

    expect(JSON.parse(r).error).toBe("Permission denied");
  });

  test("tool-runner permission.ask allows by default", async () => {
    const r = await executeAgentTool(tc("think", { thought: "x" }), baseToolDeps(), mockLog);
    // Without hooks, permission defaults to true → falls through to unknown tool
    expect(JSON.parse(r).error).toContain("Unknown tool");
  });

  test("AgentPipeline.setHooks passes hooks to phases", async () => {
    const pipeline = new AgentPipeline(
      mockMemory,
      mockRouter,
      mockRag,
      {} as ToolExecutor,
      mockRegistry,
    );

    const hooks = new HooksDispatcher();
    let transformCalled = false;
    hooks.register({
      name: "test-pipeline",
      setup(api) {
        api.hooks.onChatSystemTransform(async ({ system }) => {
          transformCalled = true;
          return system;
        });
      },
    });

    pipeline.setHooks(hooks);

    // Non-streaming path: continuation (firstMessage=false) to skip flash/RAG
    await pipeline.execute({
      model: "teamlead",
      messages: [
        { role: "assistant", content: "prev" },
        { role: "user", content: "hello" },
      ],
    });

    expect(transformCalled).toBe(true);
  });
});
