import { describe, expect, test } from "bun:test";
import { initAgentLoopContext } from "@subbrain/agent/pipeline/agent-loop/shared";
import { executeStep } from "@subbrain/agent/pipeline/agent-loop/step";
import type { AgentLoopRequest } from "@subbrain/agent/pipeline/agent-loop/types";
import { logger } from "@subbrain/core/lib/logger";
import type { ChatResponse, Message, Tool } from "@subbrain/core/types/providers";
import {
  makeAgentLoopDeps,
  makeStepDeps,
  makeStubMemory,
  makeStubRouter,
  makeToolRunnerDeps,
} from "./lib/agent-loop-fixtures";

const log = logger.forRequest("test-req", "test-sess");
const stopChoice = {
  index: 0,
  finish_reason: "stop" as const,
  message: { role: "assistant" as const, content: "" },
};
const helloChoice = {
  index: 0,
  finish_reason: "stop" as const,
  message: { role: "assistant" as const, content: "hello" },
};

// ─── initAgentLoopContext ──────────────────────────────────────────

describe("initAgentLoopContext", () => {
  test("systemMessage overrides default system prompt content", async () => {
    const memory = makeStubMemory();
    const router = makeStubRouter({ response: { choices: [stopChoice] } });
    const deps = makeAgentLoopDeps({ memory, router });
    const req: AgentLoopRequest = {
      task: "do something",
      systemMessage: "custom system",
      userMessage: "custom user",
    };
    const ctx = await initAgentLoopContext(deps, req);
    expect(ctx.messages[0]?.role).toBe("system");
    expect(ctx.messages[0]?.content).toBe("custom system");
    expect(ctx.messages[1]?.role).toBe("user");
    expect(ctx.messages[1]?.content).toBe("custom user");
    memory.close();
  });

  test("userMessage falls back to task when not provided", async () => {
    const memory = makeStubMemory();
    const router = makeStubRouter({ response: { choices: [stopChoice] } });
    const deps = makeAgentLoopDeps({ memory, router });
    const ctx = await initAgentLoopContext(deps, { task: "fallback task" });
    expect(ctx.messages[1]?.role).toBe("user");
    expect(ctx.messages[1]?.content).toBe("fallback task");
    memory.close();
  });
});

// ─── executeStep request surface ───────────────────────────────────

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
    const helloResp: ChatResponse = {
      id: "r1",
      object: "chat.completion",
      created: 0,
      model: "teamlead",
      choices: [helloChoice],
    };
    const router = makeStubRouter({
      chat: (_model, params) => {
        spy.signal = params.signal;
        return Promise.resolve(helloResp);
      },
    });
    const req: AgentLoopRequest = { task: "hi", signal: controller.signal };
    await executeStep(
      makeStepDeps({ router, memory: makeStubMemory(), tools: makeToolRunnerDeps() }),
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
    const router = makeStubRouter({ response: { choices: [helloChoice], usage } });
    const calls: (typeof usage)[] = [];
    const req: AgentLoopRequest = { task: "hi", onUsage: (u) => calls.push(u) };
    await executeStep(
      makeStepDeps({ router, memory: makeStubMemory(), tools: makeToolRunnerDeps() }),
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
    const router = makeStubRouter({ response: { choices: [helloChoice] } });
    const calls: { prompt_tokens: number; completion_tokens: number; total_tokens: number }[] = [];
    const req: AgentLoopRequest = { task: "hi", onUsage: (u) => calls.push(u) };
    await executeStep(
      makeStepDeps({ router, memory: makeStubMemory(), tools: makeToolRunnerDeps() }),
      { ...baseInput, messages },
      log,
      {},
      req,
    );
    expect(calls.length).toBe(0);
  });
});
