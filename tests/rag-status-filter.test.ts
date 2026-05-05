/**
 * MEM-5 (PR 22a): RAG injection must return only rows with status='active'.
 * Pending / rejected memories are hidden from FTS and vec paths so the model
 * never cites an unapproved fact as truth.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { MemoryDB } from "../src/db";
import { RAGPipeline } from "../src/rag";

const TEST_DB = "data/test-rag-status-filter.db";

function fakeEmbed(text: string): Float32Array {
  const vec = new Float32Array(2048);
  for (let i = 0; i < text.length; i++) vec[text.charCodeAt(i) % 2048] += 1;
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

function cleanup(): void {
  for (const ext of ["", "-shm", "-wal"]) {
    const p = `${TEST_DB}${ext}`;
    if (existsSync(p)) unlinkSync(p);
  }
}

describe("RAG injection filter — status='active' only (MEM-5)", () => {
  let memory: MemoryDB;
  let rag: RAGPipeline;
  const activeSharedId = randomUUID();
  const pendingSharedId = randomUUID();
  const activeContextId = randomUUID();
  const pendingContextId = randomUUID();

  beforeAll(() => {
    cleanup();
    memory = new MemoryDB(TEST_DB);
    rag = new RAGPipeline(memory, mkRouter());

    // Seed shared: identical content, one active + one pending.
    memory.db.transaction(() => {
      memory.insertShared(
        activeSharedId,
        "tech",
        "quokka hopping pattern observed in the morning",
        "",
        "seed",
        { confidence: 0.95, status: "active" },
      );
      memory.upsertEmbedding(
        activeSharedId,
        "shared",
        fakeEmbed("quokka hopping pattern observed in the morning"),
      );
      memory.insertShared(
        pendingSharedId,
        "tech",
        "quokka hopping pattern observed in the morning",
        "",
        "seed",
        { confidence: 0.4, status: "pending" },
      );
      memory.upsertEmbedding(
        pendingSharedId,
        "shared",
        fakeEmbed("quokka hopping pattern observed in the morning"),
      );
    })();

    // Seed context: same pattern.
    memory.db.transaction(() => {
      memory.insertContext(
        activeContextId,
        "observation",
        "narwhal tusk spiraling anticlockwise counter-intuitive",
        "",
        [],
        undefined,
        { confidence: 0.9, status: "active" },
      );
      memory.upsertEmbedding(
        activeContextId,
        "context",
        fakeEmbed("narwhal tusk spiraling anticlockwise counter-intuitive"),
      );
      memory.insertContext(
        pendingContextId,
        "observation",
        "narwhal tusk spiraling anticlockwise counter-intuitive",
        "",
        [],
        undefined,
        { confidence: 0.3, status: "pending" },
      );
      memory.upsertEmbedding(
        pendingContextId,
        "context",
        fakeEmbed("narwhal tusk spiraling anticlockwise counter-intuitive"),
      );
    })();
  });

  afterAll(() => {
    memory.close();
    cleanup();
  });

  test("FTS shared: only active row returned", async () => {
    const results = await rag.search({
      query: "quokka hopping pattern",
      layers: ["shared"],
      skipRerank: true,
    });
    const ids = results.map((r) => r.id);
    expect(ids).toContain(activeSharedId);
    expect(ids).not.toContain(pendingSharedId);
  });

  test("FTS context: only active row returned", async () => {
    const results = await rag.search({
      query: "narwhal tusk spiraling",
      layers: ["context"],
      skipRerank: true,
    });
    const ids = results.map((r) => r.id);
    expect(ids).toContain(activeContextId);
    expect(ids).not.toContain(pendingContextId);
  });

  test("vec-only path shared: pending row filtered at hydration", async () => {
    const vecOnly = await rag.vecSearch("quokka hopping", ["shared"], 10);
    // Vec may return both ids (no status column on vec_embeddings), but the
    // full rag.search merges with FTS and hydrates via getSharedMany; since
    // the pending id lacks an 'active' row, its snippet stays empty and FTS
    // never emitted it — so merged results from rag.search exclude it.
    const merged = await rag.search({
      query: "quokka hopping",
      layers: ["shared"],
      skipRerank: true,
    });
    const ids = merged.map((r) => r.id);
    expect(ids).not.toContain(pendingSharedId);
    // Sanity: vec does see the ids (just to pin the split — hydration is
    // the filter, not vec itself).
    expect(vecOnly.length).toBeGreaterThan(0);
  });

  test("direct searchShared without activeOnly still sees both rows (admin path)", () => {
    const hits = memory.searchShared("quokka hopping", 10);
    const ids = hits.map((h) => h.id);
    expect(ids).toContain(activeSharedId);
    expect(ids).toContain(pendingSharedId);
  });

  test("direct getSharedMany with activeOnly filters pending", () => {
    const rows = memory.getSharedMany([activeSharedId, pendingSharedId], {
      activeOnly: true,
    });
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(activeSharedId);
    expect(ids).not.toContain(pendingSharedId);
  });

  test("direct getContextMany with activeOnly filters pending", () => {
    const rows = memory.getContextMany([activeContextId, pendingContextId], {
      activeOnly: true,
    });
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(activeContextId);
    expect(ids).not.toContain(pendingContextId);
  });
});
