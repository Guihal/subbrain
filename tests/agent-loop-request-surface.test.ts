import { describe, expect, test } from "bun:test";
import { initAgentLoopContext } from "@subbrain/agent/pipeline/agent-loop/shared";
import { executeStep } from "@subbrain/agent/pipeline/agent-loop/step";
import type { AgentLoopRequest } from "@subbrain/agent/pipeline/agent-loop/types";
import { MemoryDB } from "@subbrain/core/db";
import { logger } from "@subbrain/core/lib/logger";
import type { ModelRouter } from "@subbrain/core/lib/model-router";
import type { ChatResponse, Message, Tool } from "@subbrain/core/types/providers";

// ─── Stubs ───────────────────────────────────────────────────────

function mockMemory(): MemoryDB {
  return new MemoryDB(":memory:");
}

function mockRag() {
  return {
    search: async () => [],
  };
}

function mockRouter(
  response: Partial<ChatResponse> & { _spy?: { signal?: AbortSignal } },
): ModelRouter {
  const full: ChatResponse = {
    id: "r1",
    object: "chat.completion",
    created: 0,
    model: "teamlead",
    choices: [],
    ...response,
  };
  return {
    chat: (_model, params, _priority) => {
      if (response._spy) {
        response._spy.signal = params.signal;
      }
      return Promise.resolve(full);
    },
  } as unknown as ModelRouter;
}

function mockToolDeps(): unknown {
  return {
    registry: {
      has: () => false,
      call: async () => ({ success: true, data: null }),
      callAsAgent: async () => ({ success: true, data: null }),
    },
    tools: {},
    router: {},
    room: null,
    dynamicTools: { get: () => undefined },
    persistDynamicTools: () => {
      /* no-op */
    },
    codeTools: null,
    session: {
      consultSpecialistsCount: 0,
      consultSpecialistsMax: 3,
      consultChaosCount: 0,
      consultChaosMax: 5,
    },
  };
}

const log = logger.forRequest("test-req", "test-sess");

// ─── Tests: initAgentLoopContext ─────────────────────────────────

describe("initAgentLoopContext", () => {
  test("systemMessage overrides default system prompt content", async () => {
    const memory = mockMemory();
    const rag = mockRag();
    const router = mockRouter({
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "" } }],
    });
    const deps = {
      memory,
      rag,
      router,
      tools: {},
      registry: {},
      dynamicTools: {},
      codeTools: null,
      room: null,
      persistDynamicTools: () => {
        /* no-op */
      },
      getAllTools: () => [],
    };
    const req: AgentLoopRequest = {
      task: "do something",
      systemMessage: "custom system",
      userMessage: "custom user",
    };
    const ctx = await initAgentLoopContext(deps as any, req);
    expect(ctx.messages[0]?.role).toBe("system");
    expect(ctx.messages[0]?.content).toBe("custom system");
    expect(ctx.messages[1]?.role).toBe("user");
    expect(ctx.messages[1]?.content).toBe("custom user");
    memory.close();
  });

  test("userMessage falls back to task when not provided", async () => {
    const memory = mockMemory();
    const rag = mockRag();
    const router = mockRouter({
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "" } }],
    });
    const deps = {
      memory,
      rag,
      router,
      tools: {},
      registry: {},
      dynamicTools: {},
      codeTools: null,
      room: null,
      persistDynamicTools: () => {
        /* no-op */
      },
      getAllTools: () => [],
    };
    const req: AgentLoopRequest = { task: "fallback task" };
    const ctx = await initAgentLoopContext(deps as any, req);
    expect(ctx.messages[1]?.role).toBe("user");
    expect(ctx.messages[1]?.content).toBe("fallback task");
    memory.close();
  });
});

// ─── Tests: executeStep ──────────────────────────────────────────

describe("executeStep request surface", () => {
  const baseInput = {
    step: 1,
    maxSteps: 3,
    model: "teamlead",
    priority: "critical" as const,
    getAllTools: (): Tool[] => [],
  };

  test("signal is passed through to router.chat", async () => {
    const messages: Message[] = [{ role: "user", content: "hi" }];
    const controller = new AbortController();
    const spy = { signal: undefined as AbortSignal | undefined };
    const router = mockRouter({
      choices: [
        { index: 0, finish_reason: "stop", message: { role: "assistant", content: "hello" } },
      ],
      _spy: spy,
    });
    const tools = mockToolDeps();

    const req: AgentLoopRequest = { task: "hi", signal: controller.signal };
    await executeStep(
      { router, memory: mockMemory(), tools: tools as any },
      { ...baseInput, messages },
      log,
      {},
      req,
    );

    expect(spy.signal).toBe(controller.signal);
  });

  test("onUsage is called when response has usage", async () => {
    const messages: Message[] = [{ role: "user", content: "hi" }];
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
    const router = mockRouter({
      choices: [
        { index: 0, finish_reason: "stop", message: { role: "assistant", content: "hello" } },
      ],
      usage,
    });
    const tools = mockToolDeps();

    const calls: (typeof usage)[] = [];
    const req: AgentLoopRequest = {
      task: "hi",
      onUsage: (u) => calls.push(u),
    };
    await executeStep(
      { router, memory: mockMemory(), tools: tools as any },
      { ...baseInput, messages },
      log,
      {},
      req,
    );

    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual(usage);
  });

  test("onUsage is not called when response lacks usage", async () => {
    const messages: Message[] = [{ role: "user", content: "hi" }];
    const router = mockRouter({
      choices: [
        { index: 0, finish_reason: "stop", message: { role: "assistant", content: "hello" } },
      ],
    });
    const tools = mockToolDeps();

    const calls: { prompt_tokens: number; completion_tokens: number; total_tokens: number }[] = [];
    const req: AgentLoopRequest = {
      task: "hi",
      onUsage: (u) => calls.push(u),
    };
    await executeStep(
      { router, memory: mockMemory(), tools: tools as any },
      { ...baseInput, messages },
      log,
      {},
      req,
    );

    expect(calls.length).toBe(0);
  });
});
