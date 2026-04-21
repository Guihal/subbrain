import { describe, test, expect, beforeAll } from "bun:test";
import { unlinkSync } from "fs";
import { MemoryDB } from "../src/db";
import { RAGPipeline } from "../src/rag";
import { runHippocampus } from "../src/pipeline/agent-pipeline/post/hippocampus";
import type { ChatResponse } from "../src/providers/types";

const TEST_DB = "data/test-post-hippo.db";
try { unlinkSync(TEST_DB); } catch {}
const memory = new MemoryDB(TEST_DB);

const log = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
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

describe("post/hippocampus.runHippocampus", () => {
  test("memory_write shared then done → insertShared invoked, factsWritten=1", async () => {
    const before = memory.getAllShared().length;
    const router = mkRouter([
      {
        id: "1", object: "chat.completion", created: 0, model: "coder",
        choices: [{
          index: 0, finish_reason: "tool_calls",
          message: {
            role: "assistant", content: null,
            tool_calls: [{
              id: "c1", type: "function",
              function: {
                name: "memory_write",
                arguments: JSON.stringify({
                  layer: "shared", category: "user",
                  content: "User likes Bun runtime", tags: "bun,pref",
                }),
              },
            }],
          },
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
      {
        id: "2", object: "chat.completion", created: 0, model: "coder",
        choices: [{
          index: 0, finish_reason: "tool_calls",
          message: {
            role: "assistant", content: null,
            tool_calls: [{
              id: "c2", type: "function",
              function: { name: "done", arguments: "{}" },
            }],
          },
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    ]);

    const stats = await runHippocampus({
      memory, router, rag,
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

  test("immediate done → no writes", async () => {
    const before = memory.getAllShared().length;
    const router = mkRouter([{
      id: "x", object: "chat.completion", created: 0, model: "coder",
      choices: [{
        index: 0, finish_reason: "tool_calls",
        message: {
          role: "assistant", content: null,
          tool_calls: [{ id: "c", type: "function", function: { name: "done", arguments: "{}" } }],
        },
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }]);
    const stats = await runHippocampus({
      memory, router, rag,
      userMessage: "hi", assistantText: "hello",
      requestId: "req-test-2", log,
    });
    expect(stats.factsWritten).toBe(0);
    expect(memory.getAllShared().length).toBe(before);
  });
});
