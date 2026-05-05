import { describe, expect, test } from "bun:test";
import type { MemoryDB } from "../src/db";
import { logger } from "../src/lib/logger";
import type { ModelRouter } from "../src/lib/model-router";
import type { ToolRegistry } from "../src/mcp";
import { executeStep } from "../src/pipeline/agent-loop/step";
import type { ToolRunnerDeps } from "../src/pipeline/agent-loop/tool-runner";
import type { ChatResponse, Message, Tool } from "../src/providers/types";

function mockRouter(response: Partial<ChatResponse>): ModelRouter {
  const full: ChatResponse = {
    id: "r1",
    object: "chat.completion",
    created: 0,
    model: "teamlead",
    choices: [],
    ...response,
  };
  return { chat: async () => full } as unknown as ModelRouter;
}

function mockMemory(): MemoryDB {
  // step.ts only touches memory via maybeCompress, which is a no-op
  // while messages are small. Pass a stub.
  return {} as unknown as MemoryDB;
}

function mockToolDeps(registry: Record<string, (args: any) => unknown>): ToolRunnerDeps {
  const stubRegistry = {
    has: (name: string) => name in registry,
    call: async (name: string, args: unknown) => ({
      success: true,
      data: registry[name]?.(args),
    }),
    callAsAgent: async (name: string, args: unknown) => ({
      success: true,
      data: registry[name]?.(args as any),
    }),
  } as unknown as ToolRegistry;
  return {
    registry: stubRegistry,
    tools: {} as any,
    router: {} as any,
    room: null,
    dynamicTools: { get: () => undefined } as any,
    persistDynamicTools: () => {},
    codeTools: null,
    session: {} as any,
  };
}

const log = logger.forRequest("test-req", "test-sess");
const baseInput = {
  step: 1,
  maxSteps: 3,
  model: "teamlead",
  priority: "critical" as const,
  getAllTools: (): Tool[] => [],
};

describe("executeStep", () => {
  test("tool_calls path: dispatches tool, pushes tool_result, returns kind=tools", async () => {
    const messages: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ];
    const router = mockRouter({
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "ping", arguments: "{}" },
              },
            ],
          },
        },
      ],
    });
    const tools = mockToolDeps({ ping: () => "pong" });

    const onToolCallStart = [] as string[];
    const onToolCallResult = [] as string[];

    const result = await executeStep(
      { router, memory: mockMemory(), tools },
      { ...baseInput, messages },
      log,
      {
        onToolCallStart: (tc) => onToolCallStart.push(tc.function.name),
        onToolCallResult: (_tc, r) => onToolCallResult.push(r),
      },
    );

    expect(result).toEqual({ kind: "tools" });
    expect(onToolCallStart).toEqual(["ping"]);
    expect(onToolCallResult.length).toBe(1);
    expect(onToolCallResult[0]).toContain("pong");

    // messages now: system, user, assistant(tool_calls), tool(result)
    expect(messages.length).toBe(4);
    expect(messages[2]?.role).toBe("assistant");
    expect(messages[2]?.tool_calls?.[0]?.id).toBe("call_1");
    expect(messages[3]?.role).toBe("tool");
    expect(messages[3]?.tool_call_id).toBe("call_1");
  });

  test("done tool_call: returns kind=done with summary from arguments", async () => {
    const messages: Message[] = [{ role: "user", content: "go" }];
    const router = mockRouter({
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_done",
                type: "function",
                function: {
                  name: "done",
                  arguments: JSON.stringify({ summary: "all good" }),
                },
              },
            ],
          },
        },
      ],
    });
    const tools = mockToolDeps({ done: (a: any) => a.summary });

    const result = await executeStep(
      { router, memory: mockMemory(), tools },
      { ...baseInput, messages },
      log,
    );

    expect(result).toEqual({ kind: "done", summary: "all good" });
  });

  test("plain content: returns kind=assistant and nudges via user message", async () => {
    const messages: Message[] = [{ role: "user", content: "hi" }];
    const router = mockRouter({
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: "hello" },
        },
      ],
    });
    const tools = mockToolDeps({});

    const result = await executeStep(
      { router, memory: mockMemory(), tools },
      { ...baseInput, messages },
      log,
    );

    expect(result).toEqual({ kind: "assistant", content: "hello" });
    // budget note was popped, nudge was pushed
    const last = messages[messages.length - 1];
    expect(last?.role).toBe("user");
    expect(last?.content).toContain("автономном режиме");
  });

  test("empty response: returns kind=empty and pushes empty-nudge", async () => {
    const messages: Message[] = [{ role: "user", content: "hi" }];
    const router = mockRouter({
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: "" },
        },
      ],
    });
    const tools = mockToolDeps({});

    const result = await executeStep(
      { router, memory: mockMemory(), tools },
      { ...baseInput, messages },
      log,
    );

    expect(result).toEqual({ kind: "empty" });
    const last = messages[messages.length - 1];
    expect(last?.content).toContain("Пустой ответ");
  });

  test("no choices: returns kind=error", async () => {
    const messages: Message[] = [{ role: "user", content: "hi" }];
    const router = mockRouter({ choices: [] });
    const tools = mockToolDeps({});

    const result = await executeStep(
      { router, memory: mockMemory(), tools },
      { ...baseInput, messages },
      log,
    );

    expect(result.kind).toBe("error");
  });

  test("budget note is always popped, even on router throw", async () => {
    const messages: Message[] = [{ role: "user", content: "hi" }];
    const router = {
      chat: async () => {
        throw new Error("boom");
      },
    } as unknown as ModelRouter;
    const tools = mockToolDeps({});

    await expect(
      executeStep({ router, memory: mockMemory(), tools }, { ...baseInput, messages }, log),
    ).rejects.toThrow("boom");

    // should have been popped → only the original message remains
    expect(messages.length).toBe(1);
  });
});
