/**
 * PR 24 — vec path for shared layer must hydrate row metadata.
 * Regression: before PR 24, rag/pipeline.ts:vecSearch skipped shared-row
 * hydration ("intentional — no regression"), so vec hits for shared had
 * empty snippet and title = id. With getSharedMany, snippet is populated.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { unlinkSync } from "fs";
import { randomUUID } from "crypto";
import { MemoryDB } from "../src/db";
import { RAGPipeline } from "../src/rag";

const TEST_DB = "data/test-rag-shared-vec.db";

// Deterministic embedding: favours overlapping char sets → near-identical
// inputs stay close in L2 distance.
function fakeEmbed(text: string): Float32Array {
  const vec = new Float32Array(2048);
  for (let i = 0; i < text.length; i++) {
    vec[text.charCodeAt(i) % 2048] += 1;
  }
  vec[0] += 0.01;
  return vec;
}

function mkRouter() {
  return {
    raw: {
      embed: async (req: { input: string[] }) => ({
        data: req.input.map((t) => ({ embedding: Array.from(fakeEmbed(t)) })),
      }),
      rerank: async () => ({ results: [] }),
    },
    scheduleRaw: async (_p: string, fn: () => Promise<any>) => fn(),
  } as any;
}

describe("RAG vec path — shared layer snippet hydration (PR 24)", () => {
  let memory: MemoryDB;
  let rag: RAGPipeline;
  const seededIds: Record<string, string> = {};

  beforeAll(() => {
    try { unlinkSync(TEST_DB); } catch {}
    memory = new MemoryDB(TEST_DB);
    rag = new RAGPipeline(memory, mkRouter());

    const rows: Array<{ category: string; content: string }> = [
      { category: "tech", content: "SNMP discovery uses UDP 161 for polling" },
      { category: "pref", content: "user prefers Bun runtime over node" },
      { category: "fact", content: "freelance scout polls fl.ru kwork.ru" },
    ];
    for (const r of rows) {
      const id = randomUUID();
      seededIds[r.content] = id;
      memory.db.transaction(() => {
        memory.insertShared(id, r.category, r.content, "", "seed");
        memory.upsertEmbedding(id, "shared", fakeEmbed(r.content));
      })();
    }
  });

  test("vecSearch shared returns hit with non-empty snippet + real title", async () => {
    const results = await rag.vecSearch(
      "SNMP discovery UDP 161",
      ["shared"],
      5,
    );
    expect(results.length).toBeGreaterThan(0);

    const expectedId = seededIds["SNMP discovery uses UDP 161 for polling"];
    const hit = results.find((r) => r.id === expectedId);
    expect(hit).toBeDefined();
    expect(hit!.layer).toBe("shared");
    // snippet hydrated (previously was "")
    expect(hit!.snippet.length).toBeGreaterThan(0);
    expect(hit!.snippet).toContain("SNMP");
    // title is mapped from SharedRow.category (previously was id)
    expect(hit!.title).toBe("tech");
    expect(hit!.title).not.toBe(hit!.id);
  });

  test("hybrid search (FTS+vec) for shared returns populated snippet", async () => {
    const results = await rag.search({
      query: "Bun runtime node preference",
      layers: ["shared"],
      skipRerank: true,
    });
    expect(results.length).toBeGreaterThan(0);

    const expectedId = seededIds["user prefers Bun runtime over node"];
    const hit = results.find((r) => r.id === expectedId);
    expect(hit).toBeDefined();
    expect(hit!.snippet.length).toBeGreaterThan(0);
    expect(hit!.snippet).toContain("Bun");
  });
});
