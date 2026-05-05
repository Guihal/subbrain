/**
 * MEM-6 night-cycle memory-dedup: cluster-merge near-duplicate rows + mark
 * expired rows as superseded_by='expired'. Operates per-layer (shared,
 * context) per-category.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { MemoryDB } from "../src/db";
import { runMemoryDedup } from "../src/pipeline/night-cycle/steps/memory-dedup";
import { RAGPipeline } from "../src/rag";

const TEST_DB = "data/test-night-memory-dedup.db";

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

describe("night-cycle runMemoryDedup (MEM-6)", () => {
  let memory: MemoryDB;
  let rag: RAGPipeline;

  beforeAll(async () => {
    cleanup();
    memory = new MemoryDB(TEST_DB);
    rag = new RAGPipeline(memory, mkRouter());

    // Three near-identical preferences (same category, near-identical
    // content → cosine ≥ 0.9 with the bag-of-chars fakeEmbed).
    const seedShared = [
      ["s1", "preference", "Пользователь любит Bun runtime для backend проектов"],
      ["s2", "preference", "Пользователь любит Bun runtime для backend проектов и API"],
      ["s3", "preference", "Пользователь любит Bun runtime для backend проектов и тестов"],
      // Distinct preference (must NOT merge).
      ["s4", "preference", "Совершенно другая тема: пользователь предпочитает arch linux"],
    ];
    for (const [id, cat, content] of seedShared) {
      memory.insertShared(id, cat, content, "");
      await rag.indexEntry(id, "shared", content);
    }

    // Bump updated_at on s2 so it becomes the winner.
    await new Promise((r) => setTimeout(r, 1100));
    memory.updateShared("s2", { content: seedShared[1][2], confidence: 0.95 });

    // Two expired rows (different category, no dedup match) → both should
    // be marked superseded_by='expired'.
    const past = Math.floor(Date.now() / 1000) - 3600;
    memory.insertShared("expA", "goal", "expired goal A", "");
    memory.updateShared("expA", { expires_at: past });
    memory.insertShared("expB", "goal", "expired goal B different content", "");
    memory.updateShared("expB", { expires_at: past });
  });

  afterAll(() => {
    memory.close();
    cleanup();
  });

  test("clusters 3 near-duplicates into 1 winner; loser-2 marked superseded", async () => {
    const result = await runMemoryDedup(memory, rag);

    expect(result.shared).toBeGreaterThanOrEqual(2);
    // 2 expired rows marked.
    expect(result.expired).toBe(2);

    const s1 = memory.getShared("s1")!;
    const s2 = memory.getShared("s2")!;
    const s3 = memory.getShared("s3")!;
    const s4 = memory.getShared("s4")!;

    // Exactly one of s1/s2/s3 is the winner (max updated_at = s2 — bumped).
    const survivors = [s1, s2, s3].filter((r) => r.superseded_by === null);
    expect(survivors.length).toBe(1);
    const winner = survivors[0];
    expect(winner.id).toBe("s2");

    // Other two point at the winner.
    for (const r of [s1, s3]) {
      if (r.id === winner.id) continue;
      expect(r.superseded_by).toBe(winner.id);
    }

    // The unrelated preference (s4) is NOT touched.
    expect(s4.superseded_by).toBeNull();
  });

  test("expired rows marked superseded_by='expired'", () => {
    expect(memory.getShared("expA")?.superseded_by).toBe("expired");
    expect(memory.getShared("expB")?.superseded_by).toBe("expired");
  });
});
