/**
 * AgentPipeline routing: pre-processing, continuation skip, short-query bypass, post-log.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { AgentPipeline } from "@subbrain/agent/pipeline";
import type { MemoryDB } from "@subbrain/core/db";
import { type ChatCall, setupPipeline, teardown } from "./lib/pipeline-mocks";

const TEST_DB = "data/test-pipeline.db";

let memory: MemoryDB;
let pipeline: AgentPipeline;
let chatCalls: ChatCall[];

beforeAll(() => {
  const ctx = setupPipeline(TEST_DB);
  memory = ctx.memory;
  pipeline = ctx.pipeline;
  chatCalls = ctx.chatCalls;
});

afterAll(() => teardown(TEST_DB));
beforeEach(() => {
  chatCalls.length = 0;
});

describe("AgentPipeline routing", () => {
  test("first message → full pre-processing pipeline + Layer 4 log", async () => {
    const r = await pipeline.execute({
      model: "teamlead",
      messages: [
        {
          role: "user",
          content: "Why did we choose Bun and Elysia for the server runtime architecture?",
        },
      ],
    });
    expect(r.requestId.length).toBeGreaterThan(0);
    expect(r.sessionId.length).toBeGreaterThan(0);
    expect(r.response).toBeDefined();
    expect(r.stream).toBeUndefined();
    expect(chatCalls.length).toBeGreaterThanOrEqual(2);
    // Pre-processing (hippocampus) call comes first, then main model
    expect(chatCalls[0].model).toBe("coder");
    expect(chatCalls[chatCalls.length - 1].model).toBe("teamlead");
    const mainCall = chatCalls[chatCalls.length - 1];
    const sys = mainCall.messages.find((m) => m.role === "system")?.content || "";
    expect(sys.includes("TeamLead")).toBe(true);

    await new Promise((res) => setTimeout(res, 100));
    const logs = memory.getLogsByRequest(r.requestId);
    expect(logs.length).toBeGreaterThanOrEqual(2);
    expect(logs.some((l) => l.role === "user")).toBe(true);
    expect(logs.some((l) => l.role === "assistant")).toBe(true);
  });

  test("continuation → skip pre-processing", async () => {
    const r = await pipeline.execute({
      model: "coder",
      messages: [
        { role: "user", content: "Write the initial code" },
        { role: "assistant", content: "Here is the code..." },
        { role: "user", content: "Now add error handling" },
      ],
    });
    expect(r.response).toBeDefined();
    expect(chatCalls.length).toBe(1);
    expect(chatCalls[0].model).toBe("coder");
  });

  test("first message with focus seed injects identity into system prompt", async () => {
    const r = await pipeline.execute({
      model: "coder",
      messages: [{ role: "user", content: "Fix the bug" }],
    });
    expect(r.response).toBeDefined();
    expect(chatCalls.length).toBeGreaterThanOrEqual(1);
    const mainCall = chatCalls[chatCalls.length - 1];
    expect(mainCall.model).toBe("coder");
    const sys = mainCall.messages.find((m) => m.role === "system")?.content || "";
    expect(sys.includes("TeamLead")).toBe(true);
  });
});
