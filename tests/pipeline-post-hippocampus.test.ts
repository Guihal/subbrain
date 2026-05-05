import { describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { buildRegistry, ToolExecutor } from "@subbrain/agent/mcp";
import { runHippocampus } from "@subbrain/agent/pipeline/agent-pipeline/post/hippocampus";
import { RAGPipeline } from "@subbrain/agent/rag";
import { MemoryDB } from "@subbrain/core/db";
import type { ChatResponse } from "@subbrain/core/types/providers";

const TEST_DB = "data/test-post-hippo.db";
try {
  unlinkSync(TEST_DB);
} catch {}
const memory = new MemoryDB(TEST_DB);

const log = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as any;

function mkRouter(responses: ChatResponse[]) {
  let i = 0;
  return {
    chat: async () => responses[i++] ?? responses[responses.length - 1],
    raw: {
      embed: async () => ({ data: [{ embedding: new Array(2048).fill(0) }] }),
      rerank: async () => ({ results: [] }),
    },
    scheduleRaw: async (_p: string, fn: () => Promise<any>) => fn(),
  } as any;
}

const rag = new RAGPipeline(memory, mkRouter([]));
const registry = buildRegistry();
const executor = new ToolExecutor(memory, mkRouter([]));

describe("post/hippocampus.runHippocampus", () => {
  test("memory_write shared then done → insertShared invoked, factsWritten=1", async () => {
    const before = memory.getAllShared().length;
    const router = mkRouter([
      {
        id: "1",
        object: "chat.completion",
        created: 0,
        model: "coder",
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "c1",
                  type: "function",
                  function: {
                    name: "memory_write",
                    arguments: JSON.stringify({
                      layer: "shared",
                      category: "preference",
                      content: "User likes Bun runtime",
                      tags: "bun,pref",
                      confidence: 0.95,
                    }),
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
      {
        id: "2",
        object: "chat.completion",
        created: 0,
        model: "coder",
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "c2",
                  type: "function",
                  function: { name: "done", arguments: "{}" },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    ]);

    const stats = await runHippocampus({
      memory,
      router,
      rag,
      executor,
      registry,
      userMessage: "Я люблю Bun",
      assistantText: "Понял, запомню",
      requestId: "req-test-1",
      log,
    });

    expect(stats.factsWritten).toBe(1);
    expect(stats.steps).toBeGreaterThanOrEqual(2);
    const after = memory.getAllShared();
    expect(after.length).toBe(before + 1);
    expect(after.some((s) => s.content.includes("Bun runtime"))).toBe(true);
  });

  test("text-only response → nudge → done on retry (parity with agent-loop)", async () => {
    const router = mkRouter([
      {
        id: "n1",
        object: "chat.completion",
        created: 0,
        model: "memory",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: "Да, вижу. Всё зафиксировано." },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
      {
        id: "n2",
        object: "chat.completion",
        created: 0,
        model: "memory",
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                { id: "c", type: "function", function: { name: "done", arguments: "{}" } },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    ]);
    const stats = await runHippocampus({
      memory,
      router,
      rag,
      executor,
      registry,
      userMessage: "ok",
      assistantText: "ack",
      requestId: "req-nudge-retry",
      log,
    });
    expect(stats.steps).toBeGreaterThanOrEqual(1);
  });

  test("two consecutive text-only responses → break after nudge exhausted", async () => {
    const textOnly = {
      id: "t",
      object: "chat.completion" as const,
      created: 0,
      model: "memory",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant" as const, content: "Готово." },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    let calls = 0;
    const router = {
      chat: async () => {
        calls++;
        return textOnly;
      },
    } as any;
    const stats = await runHippocampus({
      memory,
      router,
      rag,
      executor,
      registry,
      userMessage: "x",
      assistantText: "y",
      requestId: "req-nudge-exhaust",
      log,
    });
    expect(calls).toBe(2);
    expect(stats.factsWritten).toBe(0);
  });

  test("immediate done → no writes", async () => {
    const before = memory.getAllShared().length;
    const router = mkRouter([
      {
        id: "x",
        object: "chat.completion",
        created: 0,
        model: "coder",
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                { id: "c", type: "function", function: { name: "done", arguments: "{}" } },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    ]);
    const stats = await runHippocampus({
      memory,
      router,
      rag,
      executor,
      registry,
      userMessage: "hi",
      assistantText: "hello",
      requestId: "req-test-2",
      log,
    });
    expect(stats.factsWritten).toBe(0);
    expect(memory.getAllShared().length).toBe(before);
  });
});
