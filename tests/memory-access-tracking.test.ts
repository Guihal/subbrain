/**
 * M-02 (mig 10): access tracking columns + repo.bumpAccess + RAG-side
 * non-blocking bump after rerank.
 *
 * Foundation for M-03 (salience reinforce-on-access) and M-08 (Ebbinghaus
 * recency decay). The fields themselves are signals, not ranking inputs —
 * tests assert plumbing only, not retrieval semantics.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { MemoryDB } from "../src/db";
import { RAGPipeline } from "../src/rag";

const TEST_DB = "data/test-mem2-access.db";

function cleanup() {
  for (const ext of ["", "-shm", "-wal"]) {
    const p = `${TEST_DB}${ext}`;
    if (existsSync(p)) unlinkSync(p);
  }
}

// Deterministic 2048-dim "embedding" — character histogram. Good enough
// for vec_embeddings round-tripping; the actual rerank is mocked out.
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
      // Identity rerank — preserve input order so test 4 can assert which
      // ids end up in the final top-K deterministically.
      rerank: async (req: { passages: { text: string }[]; top_n: number }) => ({
        results: req.passages.slice(0, req.top_n).map((_, i) => ({
          index: i,
          relevance_score: 1 - i * 0.01,
        })),
      }),
    },
    scheduleRaw: async (_priority: string, fn: () => Promise<unknown>) => fn(),
  } as unknown as import("../src/lib/model-router").ModelRouter;
}

// Wait for the next macrotask so the fire-and-forget Promise.allSettled
// inside RAGPipeline.bumpAccessAsync has a chance to settle. 50ms is
// generous on bun's event loop — the actual UPDATE is sub-ms.
const flush = () => new Promise<void>((r) => setTimeout(r, 50));

describe("M-02 — access tracking columns + bumpAccess + RAG hook", () => {
  let memory: MemoryDB;

  beforeAll(() => {
    cleanup();
    memory = new MemoryDB(TEST_DB);
  });

  afterAll(() => {
    memory.close();
    cleanup();
  });

  test("Migration 10 applies and bumps user_version >= 10", () => {
    const row = memory.db.query<{ user_version: number }, []>("PRAGMA user_version").get()!;
    expect(row.user_version).toBeGreaterThanOrEqual(10);
  });

  test("re-running migrate() on the same DB is idempotent", () => {
    // Re-open a fresh handle to the same path — constructor calls migrate()
    // again. Must not throw "duplicate column name" or similar.
    const m2 = new MemoryDB(TEST_DB);
    const row = m2.db.query<{ user_version: number }, []>("PRAGMA user_version").get()!;
    expect(row.user_version).toBeGreaterThanOrEqual(10);
    m2.close();
  });

  test("shared_memory has last_accessed_at + access_count columns", () => {
    const cols = memory.db.query("PRAGMA table_info(shared_memory)").all() as {
      name: string;
      notnull: number;
      dflt_value: string | null;
    }[];
    const lat = cols.find((c) => c.name === "last_accessed_at");
    const ac = cols.find((c) => c.name === "access_count");
    expect(lat).toBeDefined();
    expect(ac).toBeDefined();
    expect(ac?.notnull).toBe(1);
    expect(ac?.dflt_value).toBe("0");
  });

  test("layer2_context has the same two columns", () => {
    const cols = memory.db.query("PRAGMA table_info(layer2_context)").all() as { name: string }[];
    expect(cols.some((c) => c.name === "last_accessed_at")).toBe(true);
    expect(cols.some((c) => c.name === "access_count")).toBe(true);
  });

  test("layer3_archive has the same two columns", () => {
    const cols = memory.db.query("PRAGMA table_info(layer3_archive)").all() as { name: string }[];
    expect(cols.some((c) => c.name === "last_accessed_at")).toBe(true);
    expect(cols.some((c) => c.name === "access_count")).toBe(true);
  });

  test("three idx_*_access indexes are present", () => {
    const idx = memory.db
      .query("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%_access'")
      .all() as { name: string }[];
    const names = idx.map((r) => r.name).sort();
    expect(names).toEqual(["idx_archive_access", "idx_context_access", "idx_shared_access"]);
  });

  test("bumpAccess increments access_count for matching rows only", () => {
    memory.insertShared("bump-1", "profile", "row one", "");
    memory.insertShared("bump-2", "profile", "row two", "");
    memory.insertShared("bump-3", "profile", "row three", "");

    const tsBefore = Math.floor(Date.now() / 1000);
    memory.memoryRepo.bumpAccess("shared", ["bump-1", "bump-2"]);
    memory.memoryRepo.bumpAccess("shared", ["bump-1", "bump-2"]);

    const r1 = memory.getShared("bump-1")!;
    const r2 = memory.getShared("bump-2")!;
    const r3 = memory.getShared("bump-3")!;
    expect(r1.access_count).toBe(2);
    expect(r2.access_count).toBe(2);
    expect(r3.access_count).toBe(0);
    expect(r1.last_accessed_at).not.toBeNull();
    expect(r1.last_accessed_at!).toBeGreaterThanOrEqual(tsBefore);
    expect(r3.last_accessed_at).toBeNull();
  });

  test("bumpAccess on empty array is a no-op (no SQL exec, no throw)", () => {
    expect(() => memory.memoryRepo.bumpAccess("shared", [])).not.toThrow();
    expect(() => memory.memoryRepo.bumpAccess("context", [])).not.toThrow();
    expect(() => memory.memoryRepo.bumpAccess("archive", [])).not.toThrow();
  });

  test("RAG search bumps access_count for surviving (top-K) rows", async () => {
    // Fresh shared rows so counts start from 0 (separate from bump-1..3 above).
    for (let i = 0; i < 5; i++) {
      memory.insertShared(`rag-${i}`, "profile", `cantaloupe melon ${i}`, "");
    }

    const router = mkRouter();
    const rag = new RAGPipeline(memory, router);

    // FTS query that hits all 5 rows. rerankTopN=3 → only 3 of 5 should be
    // bumped. Default identity rerank preserves merged order.
    for (let i = 0; i < 3; i++) {
      await rag.search({
        query: "cantaloupe",
        layers: ["shared"],
        rerankTopN: 3,
      });
    }
    await flush();

    const rows = memory.db
      .query("SELECT id, access_count FROM shared_memory WHERE id LIKE 'rag-%' ORDER BY id")
      .all() as { id: string; access_count: number }[];
    const bumped = rows.filter((r) => r.access_count > 0);
    const untouched = rows.filter((r) => r.access_count === 0);
    // Exactly rerankTopN rows survive each call → bumped 3 times each.
    expect(bumped.length).toBe(3);
    for (const r of bumped) expect(r.access_count).toBe(3);
    // Remaining 2 should be untouched (never made it past rerank top-K).
    expect(untouched.length).toBe(2);
  });

  test("RAG_BUMP_ACCESS=false disables the access bump entirely", async () => {
    // Fresh rows so we can assert access_count == 0 unambiguously.
    for (let i = 0; i < 5; i++) {
      memory.insertShared(`disable-${i}`, "profile", `papaya ${i}`, "");
    }

    const prev = process.env.RAG_BUMP_ACCESS;
    process.env.RAG_BUMP_ACCESS = "false";
    try {
      const router = mkRouter();
      const rag = new RAGPipeline(memory, router);
      for (let i = 0; i < 3; i++) {
        await rag.search({
          query: "papaya",
          layers: ["shared"],
          rerankTopN: 3,
        });
      }
      await flush();

      const rows = memory.db
        .query(
          "SELECT id, access_count, last_accessed_at FROM shared_memory WHERE id LIKE 'disable-%'",
        )
        .all() as { id: string; access_count: number; last_accessed_at: number | null }[];
      for (const r of rows) {
        expect(r.access_count).toBe(0);
        expect(r.last_accessed_at).toBeNull();
      }
    } finally {
      if (prev === undefined) delete process.env.RAG_BUMP_ACCESS;
      else process.env.RAG_BUMP_ACCESS = prev;
    }
  });

  test("repeated identical search returns the same top-K (no ordering side-effect from bump)", async () => {
    const router = mkRouter();
    const rag = new RAGPipeline(memory, router);

    const a = await rag.search({
      query: "cantaloupe",
      layers: ["shared"],
      rerankTopN: 3,
    });
    await flush();
    const b = await rag.search({
      query: "cantaloupe",
      layers: ["shared"],
      rerankTopN: 3,
    });
    await flush();

    expect(a.map((r) => r.id)).toEqual(b.map((r) => r.id));
  });
});
