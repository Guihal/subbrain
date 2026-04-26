// M-08: MemoryBank-style forgetting curve. Pure-fn cases + RAG end-to-end
// with identity reranker so reordering observed = forgetting curve only.
import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { MemoryDB } from "../src/db";
import { RAGPipeline } from "../src/rag";
import {
  computeRecallScore,
  applyForgettingCurve,
} from "../src/lib/memory-decay";
import type { RAGResult } from "../src/rag/types";

const TEST_DB = "data/test-mem8-forget.db";
const DAY = 86400;

function cleanup() {
  for (const ext of ["", "-shm", "-wal"]) {
    const p = `${TEST_DB}${ext}`;
    if (existsSync(p)) unlinkSync(p);
  }
}

function fakeEmbed(text: string): Float32Array {
  const v = new Float32Array(2048);
  for (let i = 0; i < text.length; i++) v[text.charCodeAt(i) % 2048] += 1;
  return v;
}

function mkRouter() {
  return {
    raw: {
      embed: async (req: { input: string[] }) => ({
        data: req.input.map((t) => ({ embedding: Array.from(fakeEmbed(t)) })),
      }),
      rerank: async (req: { passages: { text: string }[]; top_n: number }) => ({
        results: req.passages.slice(0, req.top_n).map((_, i) => ({
          index: i,
          relevance_score: 1 - i * 0.001,
        })),
      }),
    },
    scheduleRaw: async (_p: string, fn: () => Promise<unknown>) => fn(),
  } as unknown as import("../src/lib/model-router").ModelRouter;
}

const flush = () => new Promise<void>((r) => setTimeout(r, 50));

function row(over: Partial<RAGResult> = {}): RAGResult {
  return { id: "x", layer: "context", title: "t", snippet: "s", score: 1.0, ...over };
}

describe("M-08 — forgetting curve (pure)", () => {
  test("computeRecallScore: lastAccess=null AND dt=0 both → 1.0", () => {
    expect(computeRecallScore(1_000_000, null, 0, 0.5)).toBe(1.0);
    expect(computeRecallScore(1_000_000, null, 99, 1.0)).toBe(1.0);
    expect(computeRecallScore(1_000_000, 1_000_000, 0, 0.5)).toBe(1.0);
  });

  test("computeRecallScore: 1d for default row → R≈0.37 (e^-1)", () => {
    // access_count=0, salience=0.5 → tau=1d → R(1d)=e^-1.
    const r = computeRecallScore(2_000_000, 2_000_000 - DAY, 0, 0.5);
    expect(r).toBeGreaterThan(0.36);
    expect(r).toBeLessThan(0.38);
  });

  test("higher access_count slows decay", () => {
    const now = 5_000_000;
    const cold = computeRecallScore(now, now - 7 * DAY, 0, 0.5);
    const hot = computeRecallScore(now, now - 7 * DAY, 10, 0.5);
    expect(hot).toBeGreaterThan(cold);
  });

  test("higher salience slows decay", () => {
    const now = 5_000_000;
    const dim = computeRecallScore(now, now - 7 * DAY, 0, 0.0);
    const bright = computeRecallScore(now, now - 7 * DAY, 0, 1.0);
    expect(bright).toBeGreaterThan(dim);
  });

  test("applyForgettingCurve: never-accessed row gets +W_RECALL bump", () => {
    const out = applyForgettingCurve([row()], 1_000_000, { recall: 0.15 });
    // R=1.0 (never accessed) → score *= 1 + 0.15*1 = 1.15.
    expect(out[0].score).toBeCloseTo(1.15, 5);
  });

  test("30d-old row → multiplier ≈ 1.0 (R→0, no negative score)", () => {
    const now = 10_000_000;
    const r = row({
      last_accessed_at: now - 30 * DAY,
      access_count: 0,
      salience: 0.5,
    });
    const out = applyForgettingCurve([r], now, { recall: 0.15 });
    expect(out[0].score).toBeGreaterThanOrEqual(1.0);
    expect(out[0].score).toBeLessThan(1.001);
  });

  test("persona override: kind='persona' shared row pinned to R=1.0 (never decays)", () => {
    // 30d-old persona must score same as a never-accessed row: R=1.0
    // forced by override → score *= 1 + 0.15*1 = 1.15. Crucial invariant:
    // a stale-but-persona row outranks a stale semantic peer (which
    // gets ×~1.0). Without this pin, the no-bump branch would let
    // never-accessed semantics jump persona on identical-content queries.
    const now = 10_000_000;
    const r = row({
      layer: "shared",
      kind: "persona",
      last_accessed_at: now - 30 * DAY,
      access_count: 0,
      salience: 0.5,
    });
    const out = applyForgettingCurve([r], now, { recall: 0.15 });
    expect(out[0].score).toBeCloseTo(1.15, 5);
  });

  test("re-sort respects new order: fresh ranks above stale", () => {
    const now = 10_000_000;
    const stale = row({
      id: "stale",
      last_accessed_at: now - 30 * DAY,
      access_count: 0,
      salience: 0.5,
    });
    const fresh = row({
      id: "fresh",
      last_accessed_at: now - 60,
      access_count: 1,
      salience: 0.5,
    });
    const out = applyForgettingCurve([stale, fresh], now, { recall: 0.15 });
    out.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    expect(out[0].id).toBe("fresh");
    expect(out[1].id).toBe("stale");
  });

  test("weights.recall=0 disables effect (multiplier collapses to 1.0)", () => {
    const now = 10_000_000;
    const r = row({
      score: 0.5,
      last_accessed_at: now - 60,
      access_count: 5,
      salience: 0.9,
    });
    const out = applyForgettingCurve([r], now, { recall: 0 });
    expect(out[0].score).toBe(0.5);
  });

  // ─── M-08.1: per-kind decay tuning ────────────────────────────
  test("M-08.1: episodic decays faster than semantic (same params)", () => {
    const now = 5_000_000;
    const dt = 2 * DAY;
    const sem = computeRecallScore(now, now - dt, 0, 0.5, "semantic");
    const ep = computeRecallScore(now, now - dt, 0, 0.5, "episodic");
    expect(ep).toBeLessThan(sem);
    // Default mult 0.5 → tau half → R = exp(-2*dt/tau_sem) = sem^2.
    expect(ep).toBeCloseTo(sem * sem, 5);
  });

  test("M-08.1: procedural decays slower than semantic (same params)", () => {
    const now = 5_000_000;
    const dt = 2 * DAY;
    const sem = computeRecallScore(now, now - dt, 0, 0.5, "semantic");
    const proc = computeRecallScore(now, now - dt, 0, 0.5, "procedural");
    expect(proc).toBeGreaterThan(sem);
    // Default mult 2.0 → tau double → R = exp(-dt/(2*tau_sem)) = sqrt(sem).
    expect(proc).toBeCloseTo(Math.sqrt(sem), 5);
  });

  test("M-08.1: kind=undefined matches semantic (baseline unchanged)", () => {
    const now = 5_000_000;
    const dt = 3 * DAY;
    const undef = computeRecallScore(now, now - dt, 0, 0.5);
    const sem = computeRecallScore(now, now - dt, 0, 0.5, "semantic");
    expect(undef).toBe(sem);
  });

  test("M-08.1: RAG_DECAY_MULT_EPISODIC=1.0 → episodic == semantic (env override)", () => {
    const now = 5_000_000;
    const dt = 2 * DAY;
    const prev = process.env.RAG_DECAY_MULT_EPISODIC;
    process.env.RAG_DECAY_MULT_EPISODIC = "1.0";
    try {
      const ep = computeRecallScore(now, now - dt, 0, 0.5, "episodic");
      const sem = computeRecallScore(now, now - dt, 0, 0.5, "semantic");
      expect(ep).toBe(sem);
    } finally {
      if (prev === undefined) delete process.env.RAG_DECAY_MULT_EPISODIC;
      else process.env.RAG_DECAY_MULT_EPISODIC = prev;
    }
  });

  test("M-08.1: persona override unchanged — kind='persona' still R=1.0 via skipPersona", () => {
    // Regression: per-kind multiplier path must NOT bypass the persona pin.
    const now = 10_000_000;
    const r = row({
      layer: "shared",
      kind: "persona",
      last_accessed_at: now - 30 * DAY,
      access_count: 0,
      salience: 0.5,
    });
    const out = applyForgettingCurve([r], now, { recall: 0.15 });
    expect(out[0].score).toBeCloseTo(1.15, 5);
  });
});

describe("M-08 — forgetting curve (RAG end-to-end)", () => {
  let memory: MemoryDB;

  beforeAll(() => {
    cleanup();
    memory = new MemoryDB(TEST_DB);
  });

  afterAll(() => {
    memory.close();
    cleanup();
  });

  beforeEach(() => {
    memory.db.query("DELETE FROM shared_memory").run();
    delete process.env.RAG_RECALL_WEIGHT;
  });

  test("end-to-end: fresh + persona-old rank above semantic-old", async () => {
    const now = Math.floor(Date.now() / 1000);
    memory.insertShared("fresh-sem", "fact", "starfruit fresh", "", undefined, { kind: "semantic" });
    memory.insertShared("old-sem", "fact", "starfruit aged", "", undefined, { kind: "semantic" });
    memory.insertShared("old-pers", "profile", "starfruit identity", "", undefined, { kind: "persona" });

    memory.db.query("UPDATE shared_memory SET last_accessed_at = ?, access_count = 1 WHERE id = ?")
      .run(now - 60, "fresh-sem");
    memory.db.query("UPDATE shared_memory SET last_accessed_at = ?, access_count = 1 WHERE id = ?")
      .run(now - 30 * DAY, "old-sem");
    memory.db.query("UPDATE shared_memory SET last_accessed_at = ?, access_count = 1 WHERE id = ?")
      .run(now - 30 * DAY, "old-pers");

    const rag = new RAGPipeline(memory, mkRouter());
    const out = await rag.search({ query: "starfruit", layers: ["shared"], rerankTopN: 5 });
    await flush();

    const idx = (id: string) => out.findIndex((r) => r.id === id);
    expect(idx("fresh-sem")).toBeGreaterThanOrEqual(0);
    expect(idx("old-sem")).toBeGreaterThanOrEqual(0);
    expect(idx("old-pers")).toBeGreaterThanOrEqual(0);
    // Stale semantic must rank below both fresh-semantic and old-persona.
    expect(idx("old-sem")).toBeGreaterThan(idx("fresh-sem"));
    expect(idx("old-sem")).toBeGreaterThan(idx("old-pers"));
  });

  test("end-to-end: RAG_RECALL_WEIGHT=0 disables the curve (gap shrinks)", async () => {
    // Strategy: with default weight the fresh row's score is multiplied by
    // (1 + 0.15*1.0) = 1.15 while the 30d-old stale row gets ≈ 1.0 — a big
    // gap. Setting weight=0 collapses both multipliers to 1.0, so the
    // post-curve gap shrinks to whatever upstream produced.
    const now = Math.floor(Date.now() / 1000);
    const setup = () => {
      memory.db.query("DELETE FROM shared_memory").run();
      memory.insertShared("zw-fresh", "fact", "papaya fresh", "", undefined, { kind: "semantic" });
      memory.insertShared("zw-stale", "fact", "papaya stale", "", undefined, { kind: "semantic" });
      memory.db.query("UPDATE shared_memory SET updated_at = ?, last_accessed_at = ?, access_count = 1, salience = 0.5 WHERE id = ?")
        .run(now, now - 60, "zw-fresh");
      memory.db.query("UPDATE shared_memory SET updated_at = ?, last_accessed_at = ?, access_count = 1, salience = 0.5 WHERE id = ?")
        .run(now, now - 30 * DAY, "zw-stale");
    };

    // 1. Default weight (curve on).
    setup();
    delete process.env.RAG_RECALL_WEIGHT;
    const ragOn = new RAGPipeline(memory, mkRouter());
    const outOn = await ragOn.search({ query: "papaya", layers: ["shared"], rerankTopN: 5 });
    await flush();
    const gapOn = (outOn.find((r) => r.id === "zw-fresh")!.score) -
                  (outOn.find((r) => r.id === "zw-stale")!.score);

    // 2. Weight=0 (curve off).
    setup();
    process.env.RAG_RECALL_WEIGHT = "0";
    const ragOff = new RAGPipeline(memory, mkRouter());
    const outOff = await ragOff.search({ query: "papaya", layers: ["shared"], rerankTopN: 5 });
    await flush();
    const gapOff = (outOff.find((r) => r.id === "zw-fresh")!.score) -
                   (outOff.find((r) => r.id === "zw-stale")!.score);

    // Curve-on gap must be larger (R=1 for fresh vs R≈0 for stale →
    // fresh gets +15% bump, stale gets ~+0%).
    expect(gapOn).toBeGreaterThan(gapOff);
  });
});
