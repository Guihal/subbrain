/**
 * MEM-6: RAG/pre filtering — expired and superseded rows must NOT appear in
 * RAG search results. Pre-phase preserves pending visibility but hides stale.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { MemoryDB } from "../src/db";
import { RAGPipeline } from "../src/rag";

const TEST_DB = "data/test-rag-active-filter.db";

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

function cleanup() {
  for (const ext of ["", "-shm", "-wal"]) {
    const p = `${TEST_DB}${ext}`;
    if (existsSync(p)) unlinkSync(p);
  }
}

describe("RAG active+notStale filter (MEM-6)", () => {
  let memory: MemoryDB;
  let rag: RAGPipeline;
  const ID_FRESH = "fresh-row";
  const ID_EXPIRED = "expired-row";
  const ID_SUPERSEDED = "superseded-row";

  beforeAll(async () => {
    cleanup();
    memory = new MemoryDB(TEST_DB);
    rag = new RAGPipeline(memory, mkRouter());

    const nowSec = Math.floor(Date.now() / 1000);

    // 1. Fresh row.
    memory.insertShared(ID_FRESH, "preference", "ralph kafka mongo unique-token-fresh", "");
    await rag.indexEntry(ID_FRESH, "shared", "ralph kafka mongo unique-token-fresh");

    // 2. Expired row (expires_at in the past).
    memory.insertShared(ID_EXPIRED, "preference", "ralph kafka mongo unique-token-expired", "");
    await rag.indexEntry(ID_EXPIRED, "shared", "ralph kafka mongo unique-token-expired");
    memory.updateShared(ID_EXPIRED, { expires_at: nowSec - 60 });

    // 3. Superseded row.
    memory.insertShared(
      ID_SUPERSEDED,
      "preference",
      "ralph kafka mongo unique-token-superseded",
      "",
    );
    await rag.indexEntry(ID_SUPERSEDED, "shared", "ralph kafka mongo unique-token-superseded");
    memory.updateShared(ID_SUPERSEDED, { superseded_by: ID_FRESH });
  });

  afterAll(() => {
    memory.close();
    cleanup();
  });

  test("rag.search excludes expired + superseded shared rows", async () => {
    const results = await rag.search({
      query: "ralph kafka mongo unique-token",
      layers: ["shared"],
      skipRerank: true,
    });
    const ids = results.map((r) => r.id);
    expect(ids).toContain(ID_FRESH);
    expect(ids).not.toContain(ID_EXPIRED);
    expect(ids).not.toContain(ID_SUPERSEDED);
  });

  test("memory.searchShared({notStale:true}) hides stale rows", () => {
    const hits = memory.searchShared("ralph kafka mongo", 10, { notStale: true });
    const ids = hits.map((h) => h.id);
    expect(ids).toContain(ID_FRESH);
    expect(ids).not.toContain(ID_EXPIRED);
    expect(ids).not.toContain(ID_SUPERSEDED);
  });

  test("memory.searchShared() without filter shows all (admin path)", () => {
    const hits = memory.searchShared("ralph kafka mongo", 10);
    const ids = hits.map((h) => h.id);
    expect(ids).toContain(ID_FRESH);
    expect(ids).toContain(ID_EXPIRED);
    expect(ids).toContain(ID_SUPERSEDED);
  });

  test("memory.getSharedMany({notStale:true}) drops stale rows from batch lookup", () => {
    const rows = memory.getSharedMany([ID_FRESH, ID_EXPIRED, ID_SUPERSEDED], { notStale: true });
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(ID_FRESH);
    expect(ids).not.toContain(ID_EXPIRED);
    expect(ids).not.toContain(ID_SUPERSEDED);
  });
});
