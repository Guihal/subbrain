/**
 * M-03 (mig 13): salience reinforce-on-access + night-cycle decay step +
 * RAG rerank salience boost.
 *
 * Verifies:
 *   1. Migration 13 adds salience + last_decayed_at on 3 layers.
 *   2. bumpAccess reinforces salience (capped at 1.0).
 *   3. Reinforce formula respects age (older row → smaller bonus).
 *   4. decay-salience step decreases salience proportionally to days.
 *   5. decay-salience is idempotent (second same-day run = no change).
 *   6. decay-salience floors at 0.001 (skips essentially-cold rows).
 *   7. RAG rerank applies salience boost (hot row outranks cold).
 *   8. Persona + salience boosts compound multiplicatively.
 */
import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
} from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { MemoryDB } from "../src/db";
import { RAGPipeline } from "../src/rag";
import { decaySalience } from "../src/pipeline/night-cycle/steps/decay-salience";

const TEST_DB = "data/test-mem3-salience.db";

function cleanup() {
  for (const ext of ["", "-shm", "-wal"]) {
    const p = `${TEST_DB}${ext}`;
    if (existsSync(p)) unlinkSync(p);
  }
}

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
      // Identity rerank — preserve input order so tests can assert
      // re-ordering caused exclusively by post-rerank boosts.
      rerank: async (req: { passages: { text: string }[]; top_n: number }) => ({
        results: req.passages.slice(0, req.top_n).map((_, i) => ({
          index: i,
          relevance_score: 1 - i * 0.001,
        })),
      }),
    },
    scheduleRaw: async (_priority: string, fn: () => Promise<unknown>) => fn(),
  } as unknown as import("../src/lib/model-router").ModelRouter;
}

const flush = () => new Promise<void>((r) => setTimeout(r, 50));

describe("M-03 — salience: migration 13 + reinforce + decay + rerank boost", () => {
  let memory: MemoryDB;

  beforeAll(() => {
    cleanup();
    memory = new MemoryDB(TEST_DB);
  });

  afterAll(() => {
    memory.close();
    cleanup();
  });

  test("migration 13 applied + salience + last_decayed_at columns on 3 layers", () => {
    const ver = memory.db
      .query<{ user_version: number }, []>("PRAGMA user_version")
      .get()!.user_version;
    expect(ver).toBeGreaterThanOrEqual(13);

    for (const table of ["shared_memory", "layer2_context", "layer3_archive"]) {
      const cols = memory.db
        .query(`PRAGMA table_info(${table})`)
        .all() as { name: string; notnull: number; dflt_value: string | null; type: string }[];
      const sal = cols.find((c) => c.name === "salience");
      const ldec = cols.find((c) => c.name === "last_decayed_at");
      expect(sal).toBeDefined();
      expect(sal!.notnull).toBe(1);
      expect(sal!.dflt_value).toBe("0.5");
      expect(sal!.type.toUpperCase()).toBe("REAL");
      expect(ldec).toBeDefined();
      expect(ldec!.notnull).toBe(0);
      expect(ldec!.type.toUpperCase()).toBe("INTEGER");
    }
  });

  test("re-running migrate() is idempotent (no duplicate column throw)", () => {
    const m2 = new MemoryDB(TEST_DB);
    const ver = m2.db
      .query<{ user_version: number }, []>("PRAGMA user_version")
      .get()!.user_version;
    expect(ver).toBeGreaterThanOrEqual(13);
    m2.close();
  });

  test("bumpAccess reinforces salience above the 0.5 default", () => {
    memory.insertShared("sal-1", "profile", "fresh row", "");
    const before = memory.getShared("sal-1")!;
    expect(before.salience).toBeCloseTo(0.5, 5);

    memory.memoryRepo.bumpAccess("shared", ["sal-1"]);
    memory.memoryRepo.bumpAccess("shared", ["sal-1"]);
    memory.memoryRepo.bumpAccess("shared", ["sal-1"]);

    const after = memory.getShared("sal-1")!;
    // 3 bumps with age ≈ 0 → bonus ≈ 0.05 each → ~0.65. Allow slack for
    // age-decay between consecutive bumps within the same second.
    expect(after.salience!).toBeGreaterThan(0.5);
    expect(after.salience!).toBeLessThanOrEqual(1.0);
    expect(after.salience!).toBeGreaterThanOrEqual(0.55);
  });

  test("bumpAccess saturates at 1.0", () => {
    memory.insertShared("sal-sat", "profile", "many hits", "");
    for (let i = 0; i < 100; i++) {
      memory.memoryRepo.bumpAccess("shared", ["sal-sat"]);
    }
    const row = memory.getShared("sal-sat")!;
    expect(row.salience!).toBeLessThanOrEqual(1.0);
    expect(row.salience!).toBeGreaterThan(0.95);
  });

  test("reinforce formula honors age (older row → smaller bonus)", () => {
    // Two fresh rows; manually backdate one's last_accessed_at by 30 days.
    memory.insertShared("sal-fresh", "profile", "fresh", "");
    memory.insertShared("sal-old", "profile", "old", "");

    const now = Math.floor(Date.now() / 1000);
    const thirtyDaysAgo = now - 30 * 86400;
    memory.db
      .query("UPDATE shared_memory SET last_accessed_at = ? WHERE id = ?")
      .run(thirtyDaysAgo, "sal-old");

    memory.memoryRepo.bumpAccess("shared", ["sal-fresh"]);
    memory.memoryRepo.bumpAccess("shared", ["sal-old"]);

    const fresh = memory.getShared("sal-fresh")!;
    const old = memory.getShared("sal-old")!;
    // Fresh: prev last_accessed = NULL → COALESCE(NULL, now) = now → age = 0 → bonus = 0.05
    // Old: prev last_accessed = now-30d → age_days = 30 → bonus = 0.05 * exp(-30/7) ≈ 0.0007
    expect(fresh.salience!).toBeGreaterThan(old.salience!);
    expect(fresh.salience!).toBeCloseTo(0.55, 2);
    expect(old.salience!).toBeLessThan(0.51);
  });

  test("decaySalience step multiplies salience by 0.98^days_since_decayed", async () => {
    memory.insertShared("dec-1", "profile", "decay me", "");
    const tenDaysAgo = Math.floor(Date.now() / 1000) - 10 * 86400;
    // Force salience to 1.0 + last_decayed_at to 10d ago via direct SQL —
    // the decay step is the unit under test, not the seed.
    memory.db
      .query(
        "UPDATE shared_memory SET salience = 1.0, last_decayed_at = ?, last_accessed_at = ? WHERE id = ?",
      )
      .run(tenDaysAgo, tenDaysAgo, "dec-1");

    const r = await decaySalience(memory);
    expect(r.shared).toBeGreaterThanOrEqual(1);

    const after = memory.getShared("dec-1")!;
    // 1.0 * 0.98^10 ≈ 0.81707
    expect(after.salience!).toBeCloseTo(0.81707, 3);
    expect(after.last_decayed_at).not.toBeNull();
    // last_decayed_at was advanced to ~now by the step.
    expect(after.last_decayed_at!).toBeGreaterThan(tenDaysAgo + 86400);
  });

  test("decaySalience is idempotent within the same second", async () => {
    memory.insertShared("dec-idem", "profile", "stable", "");
    const fiveDaysAgo = Math.floor(Date.now() / 1000) - 5 * 86400;
    memory.db
      .query(
        "UPDATE shared_memory SET salience = 0.8, last_decayed_at = ?, last_accessed_at = ? WHERE id = ?",
      )
      .run(fiveDaysAgo, fiveDaysAgo, "dec-idem");

    await decaySalience(memory);
    const after1 = memory.getShared("dec-idem")!;

    await decaySalience(memory);
    const after2 = memory.getShared("dec-idem")!;
    // Second run: age = ~0 days → multiplier ≈ 1 → unchanged.
    expect(after2.salience!).toBeCloseTo(after1.salience!, 5);
  });

  test("decaySalience skips rows below the 0.001 floor", async () => {
    memory.insertShared("dec-floor", "profile", "essentially cold", "");
    const longAgo = Math.floor(Date.now() / 1000) - 365 * 86400;
    memory.db
      .query(
        "UPDATE shared_memory SET salience = 0.0005, last_decayed_at = ?, last_accessed_at = ? WHERE id = ?",
      )
      .run(longAgo, longAgo, "dec-floor");

    const before = memory.getShared("dec-floor")!;
    await decaySalience(memory);
    const after = memory.getShared("dec-floor")!;
    expect(after.salience).toBe(before.salience);
  });

  test("decaySalience skips rows that have never been accessed", async () => {
    memory.insertShared("dec-virgin", "profile", "never touched", "");
    const before = memory.getShared("dec-virgin")!;
    expect(before.last_accessed_at).toBeNull();
    expect(before.last_decayed_at).toBeNull();

    await decaySalience(memory);
    const after = memory.getShared("dec-virgin")!;
    // Both accessor columns NULL → WHERE filters this row out.
    expect(after.salience).toBe(0.5);
    expect(after.last_decayed_at).toBeNull();
  });

  test("RAG rerank applies salience boost — hot row outranks cold of same FTS score", async () => {
    // Two shared rows that match the same FTS query.
    memory.insertShared("hot", "preference", "honeydew melon hot", "");
    memory.insertShared("cold", "preference", "honeydew melon cold", "");
    // Pin salience: hot=0.95, cold=0.05 (force above floor).
    memory.db
      .query("UPDATE shared_memory SET salience = ? WHERE id = ?")
      .run(0.95, "hot");
    memory.db
      .query("UPDATE shared_memory SET salience = ? WHERE id = ?")
      .run(0.05, "cold");

    const router = mkRouter();
    const rag = new RAGPipeline(memory, router);

    const out = await rag.search({
      query: "honeydew",
      layers: ["shared"],
      rerankTopN: 5,
    });
    await flush();

    const idxHot = out.findIndex((r) => r.id === "hot");
    const idxCold = out.findIndex((r) => r.id === "cold");
    expect(idxHot).toBeGreaterThanOrEqual(0);
    expect(idxCold).toBeGreaterThanOrEqual(0);
    // Hot must come before cold after the salience boost.
    expect(idxHot).toBeLessThan(idxCold);
  });

  test("persona + salience boosts compound multiplicatively", async () => {
    // Two shared rows, same FTS score, both high salience.
    // Row A: persona kind (mig 12 default for category=preference is persona).
    // Row B: semantic kind (force via UPDATE).
    memory.insertShared("compound-A", "preference", "papaya tropical A", "");
    memory.insertShared("compound-B", "preference", "papaya tropical B", "");
    memory.db
      .query("UPDATE shared_memory SET kind = ? WHERE id = ?")
      .run("semantic", "compound-B");
    memory.db
      .query("UPDATE shared_memory SET salience = ? WHERE id IN (?, ?)")
      .run(0.9, "compound-A", "compound-B");

    const router = mkRouter();
    const rag = new RAGPipeline(memory, router);
    const out = await rag.search({
      query: "papaya",
      layers: ["shared"],
      rerankTopN: 5,
    });
    await flush();

    const a = out.find((r) => r.id === "compound-A");
    const b = out.find((r) => r.id === "compound-B");
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    // Persona row (A) should rank above semantic row (B): same salience,
    // same base score, persona boost 1.1× wins on top of identical
    // salience boost.
    expect(a!.score).toBeGreaterThan(b!.score);
  });
});
