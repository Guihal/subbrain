import { describe, expect, test } from "bun:test";
import { executeStep } from "@subbrain/agent/pipeline/agent-loop/step";
import { logger } from "@subbrain/core/lib/logger";
import type { ModelRouter } from "@subbrain/core/lib/model-router";
import type { ChatResponse, Message, Tool, ToolCall } from "@subbrain/core/types/providers";
import {
  makeStepDeps,
  makeStubMemory,
  makeStubRouter,
  makeToolRunnerDepsFromMap,
} from "./lib/agent-loop-fixtures";

const log = logger.forRequest("test-req", "test-sess");
const baseInput = {
  step: 1,
  maxSteps: 3,
  model: "teamlead",
  priority: "critical" as const,
  getAllTools: (): Tool[] => [],
};

type Choice = ChatResponse["choices"][number];
type AssistantMsg = Choice["message"];

const choice = (message: AssistantMsg, finish: Choice["finish_reason"] = "stop"): Choice => ({
  index: 0,
  finish_reason: finish,
  message,
});
const tcCall = (id: string, name: string, args: string): ToolCall => ({
  id,
  type: "function",
  function: { name, arguments: args },
});
const emptyTools = () => makeToolRunnerDepsFromMap({});

describe("executeStep", () => {
  test("tool_calls path: dispatches tool, pushes tool_result, returns kind=tools", async () => {
    const messages: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ];
    const asst: AssistantMsg = {
      role: "assistant",
      content: null,
      tool_calls: [tcCall("call_1", "ping", "{}")],
    };
    const router = makeStubRouter({ response: { choices: [choice(asst, "tool_calls")] } });
    const tools = makeToolRunnerDepsFromMap({ ping: () => "pong" });
    const onToolCallStart: string[] = [];
    const onToolCallResult: string[] = [];

    const result = await executeStep(
      makeStepDeps({ router, memory: makeStubMemory(), tools }),
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
    expect(messages.length).toBe(4);
    expect(messages[2]?.role).toBe("assistant");
    expect(messages[2]?.tool_calls?.[0]?.id).toBe("call_1");
    expect(messages[3]?.role).toBe("tool");
    expect(messages[3]?.tool_call_id).toBe("call_1");
  });

  test("done tool_call: returns kind=done with summary from arguments", async () => {
    const messages: Message[] = [{ role: "user", content: "go" }];
    const asst: AssistantMsg = {
      role: "assistant",
      content: null,
      tool_calls: [tcCall("call_done", "done", JSON.stringify({ summary: "all good" }))],
    };
    const router = makeStubRouter({ response: { choices: [choice(asst, "tool_calls")] } });
    const tools = makeToolRunnerDepsFromMap({
      done: (a) => (a as { summary: string }).summary,
    });
    const result = await executeStep(
      makeStepDeps({ router, memory: makeStubMemory(), tools }),
      { ...baseInput, messages },
      log,
    );
    expect(result).toEqual({ kind: "done", summary: "all good" });
  });

  test("plain content: returns kind=assistant and nudges via user message", async () => {
    const messages: Message[] = [{ role: "user", content: "hi" }];
    const router = makeStubRouter({
      response: { choices: [choice({ role: "assistant", content: "hello" })] },
    });
    const result = await executeStep(
      makeStepDeps({ router, memory: makeStubMemory(), tools: emptyTools() }),
      { ...baseInput, messages },
      log,
    );
    expect(result).toEqual({ kind: "assistant", content: "hello" });
    const last = messages[messages.length - 1];
    expect(last?.role).toBe("user");
    expect(last?.content).toContain("автономном режиме");
  });

  test("empty response: returns kind=empty and pushes empty-nudge", async () => {
    const messages: Message[] = [{ role: "user", content: "hi" }];
    const router = makeStubRouter({
      response: { choices: [choice({ role: "assistant", content: "" })] },
    });
    const result = await executeStep(
      makeStepDeps({ router, memory: makeStubMemory(), tools: emptyTools() }),
      { ...baseInput, messages },
      log,
    );
    expect(result).toEqual({ kind: "empty" });
    expect(messages[messages.length - 1]?.content).toContain("Пустой ответ");
  });

  test("no choices: returns kind=error", async () => {
    const messages: Message[] = [{ role: "user", content: "hi" }];
    const router = makeStubRouter({ response: { choices: [] } });
    const result = await executeStep(
      makeStepDeps({ router, memory: makeStubMemory(), tools: emptyTools() }),
      { ...baseInput, messages },
      log,
    );
    expect(result.kind).toBe("error");
  });

  test("budget note is always popped, even on router throw", async () => {
    const messages: Message[] = [{ role: "user", content: "hi" }];
    const throwingRouter = {
      chat: async () => {
        throw new Error("boom");
      },
    } as unknown as ModelRouter;
    await expect(
      executeStep(
        makeStepDeps({ router: throwingRouter, memory: makeStubMemory(), tools: emptyTools() }),
        { ...baseInput, messages },
        log,
      ),
    ).rejects.toThrow("boom");
    expect(messages.length).toBe(1);
  });
});
