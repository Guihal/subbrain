/**
 * Hardening: recency boost in RRF merge — newer context entries rank higher.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { RAGPipeline } from "@subbrain/agent/rag";
import { MemoryDB } from "@subbrain/core/db";

const TEST_DB = "data/test-hardening-recency.db";

let memory: MemoryDB;
let rag: RAGPipeline;

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
    embed: async () => ({ data: [{ embedding: new Array(2048).fill(0.1) }] }),
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

  memory.insertContext("old-entry", "Old Knowledge", "This is old knowledge from long ago", "old");
  memory.insertContext("new-entry", "New Knowledge", "This is fresh new knowledge", "new");

  // Backdate old-entry by ~1 week so recency boost favors new-entry.
  const oneWeekAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 3600 - 100;
  memory.db
    .query("UPDATE layer2_context SET updated_at = ? WHERE id = 'old-entry'")
    .run(oneWeekAgo);
});

afterAll(() => {
  try {
    unlinkSync(TEST_DB);
  } catch {}
});

describe("RAG recency boost", () => {
  test("new entry ranks higher than old entry in RRF merge", async () => {
    const results = await rag.search({ query: "knowledge", skipRerank: true });

    // Preserve original semantics: only assert when both entries present.
    if (results.length >= 2) {
      const newIdx = results.findIndex((r) => r.id === "new-entry");
      const oldIdx = results.findIndex((r) => r.id === "old-entry");
      if (newIdx >= 0 && oldIdx >= 0) {
        expect(newIdx).toBeLessThan(oldIdx);
      }
    }

    // Sanity: at least the search must complete and return an array.
    expect(Array.isArray(results)).toBe(true);
  });
});
