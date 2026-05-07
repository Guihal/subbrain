/**
 * Hardening: RAG embedding cache reuse + cache stats exposure.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { RAGPipeline } from "@subbrain/agent/rag";
import { MemoryDB } from "@subbrain/core/db";

const TEST_DB = "data/test-hardening-cache.db";

let memory: MemoryDB;
let rag: RAGPipeline;
let embedCallCount = 0;

const mockRouter = {
  chat: async () => ({
    id: "test",
    object: "chat.completion",
    created: Date.now(),
    model: "mock",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "ok" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
  }),
  chatStream: async () =>
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'));
        c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        c.close();
      },
    }),
  scheduleRaw: async (_p: string, fn: () => Promise<any>) => fn(),
  get isOverloaded() {
    return false;
  },
  raw: {
    embed: async () => {
      embedCallCount++;
      return { data: [{ embedding: new Array(2048).fill(0.1) }] };
    },
    rerank: async () => ({
      results: [{ index: 0, relevance_score: 0.9 }],
    }),
  },
} as any;

beforeAll(() => {
  try {
    unlinkSync(TEST_DB);
  } catch {}
  memory = new MemoryDB(TEST_DB);
  rag = new RAGPipeline(memory, mockRouter);
  memory.insertContext("hc-1", "Cache Test", "Embedding cache saves RPM budget", "cache,test");
});

afterAll(() => {
  try {
    unlinkSync(TEST_DB);
  } catch {}
});

describe("RAG embedding cache", () => {
  test("reuses cache for same query, re-embeds for different query", async () => {
    embedCallCount = 0;

    // First call — should embed
    await rag.search({ query: "embedding cache" });
    const firstCount = embedCallCount;
    expect(firstCount).toBeGreaterThanOrEqual(1);

    // Second call with same query — should use cache
    await rag.search({ query: "embedding cache" });
    expect(embedCallCount).toBe(firstCount);

    // Different query — should call embed again
    await rag.search({ query: "model router timeout" });
    expect(embedCallCount).toBeGreaterThan(firstCount);
  });

  test("cache stats exposed correctly", () => {
    expect(rag.cacheStats.size).toBeGreaterThanOrEqual(2);
    expect(rag.cacheStats.maxSize).toBe(64);
  });
});
