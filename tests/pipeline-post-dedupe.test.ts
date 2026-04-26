/**
 * MEM-6: dedupe-on-write — second write of the same fact (different
 * wording) updates the existing row instead of inserting a duplicate.
 * Confidence bumped, updated_at advances.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { MemoryDB } from "../src/db";
import { RAGPipeline } from "../src/rag";
import { writeShared, writeContext } from "../src/pipeline/agent-pipeline/post/extractors";

const TEST_DB = "data/test-post-dedupe.db";

const log = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
} as any;

// Deterministic embed: bag-of-chars hash → 2048 dims. Two strings sharing
// many chars produce vectors that are extremely close (cosine ~ 1).
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

describe("post/extractors dedupe-on-write (MEM-6)", () => {
  let memory: MemoryDB;
  let rag: RAGPipeline;

  beforeAll(() => {
    cleanup();
    memory = new MemoryDB(TEST_DB);
    rag = new RAGPipeline(memory, mkRouter());
  });

  afterAll(() => {
    memory.close();
    cleanup();
  });

  test("two near-identical writes → one row, merged + updated_at bumped", async () => {
    const before = memory.countShared();

    const r1 = await writeShared(
      memory,
      rag,
      {
        category: "preference",
        content: "Пользователь предпочитает Bun runtime для backend сервисов",
        tags: "bun,runtime",
        confidence: 0.9,
      },
      log,
    );
    expect(r1.ok).toBe(true);
    expect(r1.merged).not.toBe(true);
    const id1 = r1.id!;
    const row1 = memory.getShared(id1)!;
    const ts1 = row1.updated_at;

    // Force updated_at to differ on second write — bun:sqlite second-resolution.
    await new Promise((r) => setTimeout(r, 1100));

    const r2 = await writeShared(
      memory,
      rag,
      {
        category: "preference",
        content: "Пользователь предпочитает Bun runtime для backend сервисов и API",
        tags: "bun,api",
        confidence: 0.92,
      },
      log,
    );
    expect(r2.ok).toBe(true);
    expect(r2.merged).toBe(true);
    expect(r2.id).toBe(id1); // same row
    expect(memory.countShared()).toBe(before + 1);

    const row2 = memory.getShared(id1)!;
    // Longest content wins (mergeContent rule).
    expect(row2.content.length).toBeGreaterThanOrEqual(row1.content.length);
    // Confidence bumped (max + 0.05, capped at 1.0).
    expect(row2.confidence!).toBeGreaterThan(row1.confidence ?? 0);
    expect(row2.confidence!).toBeLessThanOrEqual(1);
    // Tags unioned.
    expect(row2.tags).toContain("bun");
    expect(row2.tags).toContain("api");
    // updated_at advanced.
    expect(row2.updated_at).toBeGreaterThan(ts1);
  });

  test("two writes in DIFFERENT categories → two rows (no cross-category merge)", async () => {
    const before = memory.countShared();
    const r1 = await writeShared(
      memory,
      rag,
      { category: "preference", content: "Любит TypeScript строгий режим", tags: "ts", confidence: 0.9 },
      log,
    );
    const r2 = await writeShared(
      memory,
      rag,
      { category: "skill", content: "Любит TypeScript строгий режим", tags: "ts", confidence: 0.9 },
      log,
    );
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r1.id).not.toBe(r2.id);
    expect(memory.countShared()).toBe(before + 2);
  });

  test("writeContext dedupe — different requestId, same fact wording", async () => {
    const before = memory.countContext();
    const r1 = await writeContext(
      memory,
      rag,
      {
        category: "decision",
        content: "Subbrain: pre-фаза фильтрует expired/superseded через notStale opt",
        tags: "rag,filter",
        confidence: 0.9,
      },
      "req-A",
      log,
    );
    expect(r1.ok).toBe(true);

    await new Promise((r) => setTimeout(r, 1100));

    const r2 = await writeContext(
      memory,
      rag,
      {
        category: "decision",
        content: "Subbrain: pre-фаза фильтрует expired/superseded через notStale opt (детально)",
        tags: "rag,filter,extra",
        confidence: 0.85,
      },
      "req-B",
      log,
    );
    expect(r2.ok).toBe(true);
    expect(r2.merged).toBe(true);
    expect(r2.id).toBe(r1.id);
    expect(memory.countContext()).toBe(before + 1);
  });
});
