/** M-09 night-cycle cross-layer dedup + archive→shared promote. See plan §Тесты. */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { MemoryDB } from "@subbrain/core/db";
import { runCrossLayerDedup } from "../src/pipeline/night-cycle/steps/cross-layer-dedup";
import { RAGPipeline } from "../src/rag";
import { MemoryService } from "../src/services/memory";

const TEST_DB = "data/test-mem9-crosslayer.db";
const ENV_KEYS = [
  "CROSS_LAYER_DEDUP_ENABLED",
  "ARCHIVE_PROMOTE_MIN_ACCESS",
  "ARCHIVE_PROMOTE_MIN_CONFIDENCE",
  "CROSS_LAYER_DEDUP_LIMIT",
] as const;

function cleanup(): void {
  for (const ext of ["", "-shm", "-wal"]) {
    const p = `${TEST_DB}${ext}`;
    if (existsSync(p)) unlinkSync(p);
  }
}

// Hand-crafted unit-norm vector. `seed` controls first dim; second dim
// fills the rest so two seeds with same family give cos ≈ cos(angle).
// Pair (a, b) cosine = dot(a, b) (since unit-norm).
function vec(a: number, b: number): Float32Array {
  const v = new Float32Array(2048);
  v[0] = a;
  v[1] = b;
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

// Two near-duplicate vectors: cos > 0.92.
const V_DUP_A = vec(1, 0.05);
const V_DUP_B = vec(1, 0.06);
// Far vector — cosine < 0.5 with V_DUP_*.
const V_FAR = vec(0, 1);

function snapshotEnv(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) out[k] = process.env[k];
  return out;
}
function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

function fakeRouter(): any {
  return {
    // MemoryService.insertShared calls rag.embedContent → router.raw.embed.
    // Here we don't care about the actual embedding for the new shared row;
    // any non-empty Float32Array satisfies the embed-empty guard.
    raw: {
      embed: async (req: { input: string[] }) => ({
        data: req.input.map(() => ({ embedding: Array.from(V_FAR) })),
      }),
      rerank: async () => ({ results: [] }),
    },
    scheduleRaw: async (_p: string, fn: () => Promise<any>) => fn(),
    chat: async () => ({ choices: [{ message: { content: "" } }] }),
  };
}

function seedContext(
  memory: MemoryDB,
  id: string,
  title: string,
  content: string,
  v: Float32Array,
): void {
  memory.insertContext(id, title, content, "");
  memory.upsertEmbedding(id, "context", v);
}
function seedArchive(
  memory: MemoryDB,
  id: string,
  title: string,
  content: string,
  v: Float32Array,
  opts: { access?: number; confidence?: number | null } = {},
): void {
  memory.insertArchive(id, title, content, "", [], opts.confidence ?? 0.9);
  memory.upsertEmbedding(id, "archive", v);
  if (opts.access !== undefined) {
    memory.db.query("UPDATE layer3_archive SET access_count = ? WHERE id = ?").run(opts.access, id);
  }
}
function seedShared(
  memory: MemoryDB,
  id: string,
  category: string,
  content: string,
  v: Float32Array,
): void {
  memory.insertShared(id, category, content, "");
  memory.upsertEmbedding(id, "shared", v);
}

describe("M-09 cross-layer dedup + archive→shared promote", () => {
  let memory: MemoryDB;
  let rag: RAGPipeline;
  let svc: MemoryService;
  let envSnap: Record<string, string | undefined>;

  afterAll(() => {
    if (memory) memory.close();
    cleanup();
  });

  beforeEach(() => {
    if (memory) memory.close();
    cleanup();
    envSnap = snapshotEnv();
    for (const k of ENV_KEYS) delete process.env[k];
    memory = new MemoryDB(TEST_DB);
    rag = new RAGPipeline(memory, fakeRouter());
    svc = new MemoryService(memory.memoryRepo, rag, memory.logRepo);
  });

  test("empty layers → all zeros, no errors", async () => {
    const r = await runCrossLayerDedup({ memory, memoryService: svc });
    expect(r).toEqual({
      pairs_examined: 0,
      supersedes_added: 0,
      promoted_to_shared: 0,
      errors: 0,
    });
    restoreEnv(envSnap);
  });

  test("context↔archive: cos≥0.92 same category → supersedes edge + superseded_by on context (older)", async () => {
    seedArchive(memory, "arc-1", "project", "Project uses Bun runtime", V_DUP_A, {
      access: 1,
      confidence: 0.4,
    });
    // Backdate context to make it OLDER than archive (so context is stale).
    seedContext(memory, "ctx-1", "project", "Project uses Bun runtime extended", V_DUP_B);
    memory.db
      .query("UPDATE layer2_context SET updated_at = updated_at - 1000 WHERE id = ?")
      .run("ctx-1");

    const r = await runCrossLayerDedup({ memory, memoryService: svc });
    expect(r.supersedes_added).toBeGreaterThanOrEqual(1);

    const edges = memory.getEdgesFromSrc("ctx-1", "context", ["supersedes"]);
    expect(edges.length).toBe(1);
    expect(edges[0].dst_id).toBe("arc-1");
    expect(edges[0].dst_layer).toBe("archive");
    expect(edges[0].weight).toBeCloseTo(1.0, 5);

    const ctx = memory.getContext("ctx-1");
    expect(ctx?.superseded_by).toBe("arc-1");
    restoreEnv(envSnap);
  });

  test("archive↔shared: edge added but archive.superseded_by NOT written (no column)", async () => {
    seedShared(memory, "shr-1", "project", "Project uses Bun runtime", V_DUP_A);
    // Older archive becomes the stale side.
    seedArchive(memory, "arc-2", "project", "Project uses Bun runtime variant", V_DUP_B, {
      access: 1,
      confidence: 0.4,
    });
    memory.db
      .query("UPDATE layer3_archive SET updated_at = updated_at - 1000 WHERE id = ?")
      .run("arc-2");

    const r = await runCrossLayerDedup({ memory, memoryService: svc });
    expect(r.supersedes_added).toBeGreaterThanOrEqual(1);

    const edges = memory.getEdgesFromSrc("arc-2", "archive", ["supersedes"]);
    expect(edges.length).toBe(1);
    expect(edges[0].dst_id).toBe("shr-1");
    expect(edges[0].dst_layer).toBe("shared");
    // Archive has no superseded_by column → the column simply doesn't exist
    // on the row; this is checked indirectly by the row being still there.
    expect(memory.getArchive("arc-2")).not.toBeNull();
    restoreEnv(envSnap);
  });

  test("context↔shared: older shared row gets superseded_by", async () => {
    seedContext(memory, "ctx-3", "project", "fresh context fact", V_DUP_A);
    seedShared(memory, "shr-3", "project", "old shared fact", V_DUP_B);
    memory.db
      .query("UPDATE shared_memory SET updated_at = updated_at - 1000 WHERE id = ?")
      .run("shr-3");

    const r = await runCrossLayerDedup({ memory, memoryService: svc });
    expect(r.supersedes_added).toBeGreaterThanOrEqual(1);

    const edges = memory.getEdgesFromSrc("shr-3", "shared", ["supersedes"]);
    expect(edges.length).toBe(1);
    expect(edges[0].dst_id).toBe("ctx-3");

    const shr = memory.getShared("shr-3");
    expect(shr?.superseded_by).toBe("ctx-3");
    restoreEnv(envSnap);
  });

  test("archive→shared promote: access≥5 + confidence≥0.7 + no shared dup → new shared + derives edge", async () => {
    seedArchive(memory, "arc-p", "project", "Project standard fact", V_DUP_A, {
      access: 10,
      confidence: 0.8,
    });
    // Existing UNRELATED shared row in same category — should NOT block (cosine far).
    seedShared(memory, "shr-other", "decision", "Decision about deploys", V_FAR);

    const r = await runCrossLayerDedup({ memory, memoryService: svc });
    expect(r.promoted_to_shared).toBe(1);

    const promoted = memory.db
      .query<{ id: string; category: string; source: string | null; kind: string }, []>(
        "SELECT id, category, source, kind FROM shared_memory WHERE source = 'archive-promote'",
      )
      .all();
    expect(promoted.length).toBe(1);
    expect(promoted[0].category).toBe("project");
    expect(promoted[0].kind).toBe("semantic");

    const edges = memory.getEdgesFromSrc("arc-p", "archive", ["derives"]);
    expect(edges.length).toBe(1);
    expect(edges[0].dst_id).toBe(promoted[0].id);
    expect(edges[0].dst_layer).toBe("shared");
    expect(edges[0].weight).toBeCloseTo(1.0, 5);
    restoreEnv(envSnap);
  });

  test("below cosine threshold → no supersede edge", async () => {
    seedContext(memory, "ctx-low", "project", "totally unrelated", V_DUP_A);
    seedArchive(memory, "arc-low", "project", "different topic entirely", V_FAR, {
      access: 0,
      confidence: 0.5,
    });

    const r = await runCrossLayerDedup({ memory, memoryService: svc });
    expect(r.supersedes_added).toBe(0);
    expect(memory.getEdgesFromSrc("ctx-low", "context", ["supersedes"]).length).toBe(0);
    expect(memory.getEdgesFromSrc("arc-low", "archive", ["supersedes"]).length).toBe(0);
    restoreEnv(envSnap);
  });

  test("below access threshold → no promote", async () => {
    seedArchive(memory, "arc-na", "project", "infrequent fact", V_DUP_A, {
      access: 2,
      confidence: 0.9,
    });

    const r = await runCrossLayerDedup({ memory, memoryService: svc });
    expect(r.promoted_to_shared).toBe(0);
    const promoted = memory.db
      .query<{ c: number }, []>(
        "SELECT count(*) AS c FROM shared_memory WHERE source = 'archive-promote'",
      )
      .get()?.c;
    expect(promoted).toBe(0);
    restoreEnv(envSnap);
  });

  test("CROSS_LAYER_DEDUP_ENABLED=false → no-op zeros", async () => {
    process.env.CROSS_LAYER_DEDUP_ENABLED = "false";
    seedArchive(memory, "arc-off", "project", "would-promote fact", V_DUP_A, {
      access: 10,
      confidence: 0.9,
    });
    seedContext(memory, "ctx-off", "project", "would-supersede", V_DUP_B);

    const r = await runCrossLayerDedup({ memory, memoryService: svc });
    expect(r).toEqual({
      pairs_examined: 0,
      supersedes_added: 0,
      promoted_to_shared: 0,
      errors: 0,
    });
    expect(memory.getEdgesFromSrc("arc-off", "archive").length).toBe(0);
    restoreEnv(envSnap);
  });

  test("skip-guard: same-category shared row cos≥0.85 already exists → no promote", async () => {
    seedShared(memory, "shr-existing", "project", "Existing shared fact about Bun", V_DUP_A);
    seedArchive(memory, "arc-dup", "project", "Archive copy of Bun fact", V_DUP_B, {
      access: 8,
      confidence: 0.85,
    });

    const r = await runCrossLayerDedup({ memory, memoryService: svc });
    expect(r.promoted_to_shared).toBe(0);
    const promoted = memory.db
      .query<{ c: number }, []>(
        "SELECT count(*) AS c FROM shared_memory WHERE source = 'archive-promote'",
      )
      .get()?.c;
    expect(promoted).toBe(0);
    restoreEnv(envSnap);
  });

  test("idempotent rerun: 2nd run promotes 0 (skip-guard hits prior insert)", async () => {
    seedArchive(memory, "arc-idem", "project", "Stable global fact", V_DUP_A, {
      access: 10,
      confidence: 0.9,
    });
    // The newly-inserted shared row will be embedded with V_FAR by fakeRouter,
    // so on rerun the skip-guard would NOT fire on cosine alone. Override the
    // router to embed the promoted row with V_DUP_A so the 2nd run sees a
    // near-duplicate shared neighbour and skips.
    rag = new RAGPipeline(memory, {
      raw: {
        embed: async (req: { input: string[] }) => ({
          data: req.input.map(() => ({ embedding: Array.from(V_DUP_A) })),
        }),
        rerank: async () => ({ results: [] }),
      },
      scheduleRaw: async (_p: string, fn: () => Promise<any>) => fn(),
      chat: async () => ({ choices: [{ message: { content: "" } }] }),
    } as any);
    svc = new MemoryService(memory.memoryRepo, rag, memory.logRepo);

    const r1 = await runCrossLayerDedup({ memory, memoryService: svc });
    expect(r1.promoted_to_shared).toBe(1);
    const r2 = await runCrossLayerDedup({ memory, memoryService: svc });
    expect(r2.promoted_to_shared).toBe(0);

    const promoted = memory.db
      .query<{ c: number }, []>(
        "SELECT count(*) AS c FROM shared_memory WHERE source = 'archive-promote'",
      )
      .get()?.c;
    expect(promoted).toBe(1);
    restoreEnv(envSnap);
  });
});
