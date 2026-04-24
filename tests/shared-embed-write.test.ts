/**
 * PR 24 — writeShared must embed + upsert vec_embedding atomically.
 * Regression: before PR 24, writeShared did not embed, so vec search
 * could not find shared rows and rag-hydration for shared was broken.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { unlinkSync } from "fs";
import { MemoryDB } from "../src/db";
import { RAGPipeline } from "../src/rag";
import { writeShared } from "../src/pipeline/agent-pipeline/post/extractors";

const TEST_DB = "data/test-shared-embed.db";

const log = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
} as any;

// Deterministic "embedding": non-zero bag-of-chars hash, 2048 dims.
function fakeEmbed(text: string): Float32Array {
  const vec = new Float32Array(2048);
  for (let i = 0; i < text.length; i++) {
    vec[text.charCodeAt(i) % 2048] += 1;
  }
  // ensure non-empty + not all-zero even for pathological inputs
  vec[0] += 0.01;
  return vec;
}

function mkRouter() {
  return {
    chat: async () => { throw new Error("router.chat not used in this test"); },
    raw: {
      embed: async (req: { input: string[] }) => ({
        data: req.input.map((t) => ({ embedding: Array.from(fakeEmbed(t)) })),
      }),
      rerank: async () => ({ results: [] }),
    },
    scheduleRaw: async (_p: string, fn: () => Promise<any>) => fn(),
  } as any;
}

describe("writeShared — embed + transactional persistence (PR 24)", () => {
  let memory: MemoryDB;
  let rag: RAGPipeline;

  beforeAll(() => {
    try { unlinkSync(TEST_DB); } catch {}
    memory = new MemoryDB(TEST_DB);
    rag = new RAGPipeline(memory, mkRouter());
  });

  test("inserts shared row AND upserts vec_embedding with layer=shared", async () => {
    const wr = await writeShared(
      memory,
      rag,
      { category: "tech", content: "fact X: SNMP uses UDP 161", tags: "snmp" },
      log,
    );
    expect(wr.ok).toBe(true);
    expect(typeof wr.id).toBe("string");

    // shared_memory row present
    const row = memory.getShared(wr.id!);
    expect(row).not.toBeNull();
    expect(row!.content).toContain("fact X");

    // vec_embedding row present for layer=shared
    const vecRow = memory.db
      .query("SELECT id, layer FROM vec_embeddings WHERE id = ?")
      .get(wr.id!) as { id: string; layer: string } | null;
    expect(vecRow).not.toBeNull();
    expect(vecRow!.layer).toBe("shared");
  });

  test("retrieveShared via RAG vec path returns populated snippet", async () => {
    // seed an extra shared row
    const wr = await writeShared(
      memory,
      rag,
      { category: "tech", content: "fact X extra content about SNMP discovery", tags: "" },
      log,
    );
    expect(wr.ok).toBe(true);

    const results = await rag.search({
      query: "fact X SNMP discovery",
      layers: ["shared"],
      skipRerank: true,
    });
    expect(results.length).toBeGreaterThan(0);

    const hit = results.find((r) => r.id === wr.id);
    expect(hit).toBeDefined();
    // snippet populated (not empty, not just id); FTS path may wrap
    // matched tokens in <b>...</b>, vec-only path returns raw content.
    expect(hit!.snippet.length).toBeGreaterThan(0);
    const plainSnippet = hit!.snippet.replace(/<\/?b>/g, "");
    expect(plainSnippet).toContain("fact X");
    // title is category (mapped from SharedRow)
    expect(hit!.title).toBe("tech");
  });

  test("embed timeout → no DB rows written (atomic)", async () => {
    const hangingRouter = {
      raw: {
        embed: () => new Promise(() => {}), // never resolves
        rerank: async () => ({ results: [] }),
      },
      scheduleRaw: async (_p: string, fn: () => Promise<any>) => fn(),
    } as any;
    const ragHang = new RAGPipeline(memory, hangingRouter);

    const before = memory.countShared();
    // Shorten the test: spy timeout is 5s in extractors; we accept the wait.
    const wr = await writeShared(
      memory,
      ragHang,
      { category: "tech", content: "should never persist", tags: "" },
      log,
    );
    expect(wr.ok).toBe(false);
    expect(wr.error).toBe("embed_timeout");
    expect(memory.countShared()).toBe(before);
  }, 10_000);
});
