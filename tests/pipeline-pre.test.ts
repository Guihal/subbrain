import { describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { runPre } from "@subbrain/agent/pipeline/agent-pipeline/phases/pre";
import { RAGPipeline } from "@subbrain/agent/rag";
import { MemoryDB } from "@subbrain/core/db";
import type { ChatResponse } from "@subbrain/core/types/providers";

const TEST_DB = "data/test-pre.db";
try {
  unlinkSync(TEST_DB);
} catch {}
const memory = new MemoryDB(TEST_DB);

memory.setFocus("identity", "TeamLead AI");
memory.setFocus("goal", "ship subbrain");

function mkRouter(summaryText: string) {
  return {
    chat: async (): Promise<ChatResponse> => ({
      id: "r",
      object: "chat.completion",
      created: 0,
      model: "coder",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: summaryText },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    raw: {
      embed: async () => ({ data: [{ embedding: new Array(2048).fill(0) }] }),
      rerank: async () => ({ results: [] }),
    },
    scheduleRaw: async (_p: string, fn: () => Promise<any>) => fn(),
  } as any;
}

const rag = new RAGPipeline(memory, mkRouter(""));

describe("phases/pre.runPre", () => {
  test("continuation skips agentic loop, injects focus only", async () => {
    const router = mkRouter("SHOULD-NOT-APPEAR");
    const result = await runPre({
      memory,
      router,
      rag,
      model: "coder",
      userMessage: "продолжаем",
      firstMessage: false,
    });
    expect(result.stats.summaryLen).toBe(0);
    expect(result.stats.ragCount).toBe(0);
    expect(result.enrichedSystemPrompt).toContain("Текущие директивы");
    expect(result.enrichedSystemPrompt).toContain("identity");
    expect(result.enrichedSystemPrompt).not.toContain("SHOULD-NOT-APPEAR");
  });

  test("first message with seed memory builds executive summary", async () => {
    const router = mkRouter("Summary: project uses Bun");
    const result = await runPre({
      memory,
      router,
      rag,
      model: "coder",
      userMessage: "что у нас по проекту?",
      firstMessage: true,
    });
    expect(result.preOutput.executiveSummary).toContain("project uses Bun");
    expect(result.enrichedSystemPrompt).toContain("Executive Summary");
    expect(result.enrichedSystemPrompt).toContain("project uses Bun");
    expect(result.stats.focusKeys).toContain("identity");
  });

  test("first message with empty memory short-circuits", async () => {
    const emptyDb = "data/test-pre-empty.db";
    try {
      unlinkSync(emptyDb);
    } catch {}
    const empty = new MemoryDB(emptyDb);
    const router = mkRouter("UNUSED");
    const result = await runPre({
      memory: empty,
      router,
      rag,
      model: "coder",
      userMessage: "hello",
      firstMessage: true,
    });
    expect(result.stats.summaryLen).toBe(0);
    expect(result.stats.steps).toBe(0);
  });
});
