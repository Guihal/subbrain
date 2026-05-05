/**
 * M-05 (mig 14): memory_edges schema + EdgesTable / EdgeRepository +
 * `linkRelated` extractor hook. Backfill from layer2_context.derived_from.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { MemoryDB } from "../src/db";
import { EdgesTable } from "../src/db/tables/edges";
import { writeContext } from "../src/pipeline/agent-pipeline/post/extractors";
import { RAGPipeline } from "../src/rag";
import { EdgeRepository } from "../src/repositories/edges.repo";

const TEST_DB = "data/test-mem5-edges.db";

const log = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => log,
} as any;

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

describe("M-05 memory_edges schema (mig 14)", () => {
  let memory: MemoryDB;

  beforeAll(() => {
    cleanup();
    memory = new MemoryDB(TEST_DB);
  });

  afterAll(() => {
    memory.close();
    cleanup();
  });

  test("memory_edges table + 3 indexes exist", () => {
    const tbl = memory.db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_edges'",
      )
      .get();
    expect(tbl?.name).toBe("memory_edges");

    const idx = memory.db
      .query<{ c: number }, []>(
        "SELECT count(*) AS c FROM sqlite_master WHERE type='index' AND name LIKE 'idx_edges%'",
      )
      .get()?.c;
    expect(idx).toBe(3);
  });

  test("PK constraint blocks duplicate (src,dst,kind) tuple via INSERT OR IGNORE", () => {
    const edges = new EdgesTable(memory.db);
    const a = edges.addEdge("a", "context", "b", "context", "relates", 0.7);
    const b = edges.addEdge("a", "context", "b", "context", "relates", 0.99);
    expect(a).toBe(true);
    expect(b).toBe(false);
    const rows = edges.getEdgesFromSrc("a", "context");
    expect(rows.length).toBe(1);
    // First insert wins (PK collision is silent skip).
    expect(rows[0].weight).toBeCloseTo(0.7, 5);
  });

  test("CHECK constraint rejects invalid edge kind", () => {
    expect(() =>
      memory.db
        .query(
          `INSERT INTO memory_edges (src_id, src_layer, dst_id, dst_layer, kind, weight)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run("x", "context", "y", "context", "bogus", 1.0),
    ).toThrow();
  });

  test("CHECK constraint rejects invalid layer", () => {
    expect(() =>
      memory.db
        .query(
          `INSERT INTO memory_edges (src_id, src_layer, dst_id, dst_layer, kind, weight)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run("x", "log", "y", "context", "relates", 1.0),
    ).toThrow();
  });

  test("getEdgesFromSrc / getEdgesToDst filter by kinds", () => {
    const edges = new EdgesTable(memory.db);
    edges.addEdge("k1", "shared", "k2", "shared", "relates", 0.5);
    edges.addEdge("k1", "shared", "k3", "shared", "derives", 1.0);
    edges.addEdge("k1", "shared", "k4", "shared", "supersedes", 1.0);

    const out = edges.getEdgesFromSrc("k1", "shared", ["relates"]);
    expect(out.length).toBe(1);
    expect(out[0].dst_id).toBe("k2");

    const allOut = edges.getEdgesFromSrc("k1", "shared");
    expect(allOut.length).toBe(3);

    const inb = edges.getEdgesToDst("k2", "shared");
    expect(inb.length).toBe(1);
    expect(inb[0].src_id).toBe("k1");
  });

  test("getRelated depth=1 returns direct out + in neighbours, no self", () => {
    const repo = new EdgeRepository(memory.db);
    repo.link("A", "context", "B", "context", "relates", 0.8);
    repo.link("A", "context", "C", "context", "relates", 0.6);
    repo.link("X", "context", "A", "context", "relates", 0.4);

    const r = repo.getRelated("A", "context", 1);
    const ids = r.map((n) => n.id).sort();
    expect(ids).toEqual(["B", "C", "X"]);
    expect(r.find((n) => n.id === "A")).toBeUndefined();
  });

  test("getRelated depth=2 walks one hop further, dedupes seed", () => {
    const repo = new EdgeRepository(memory.db);
    repo.link("D1", "context", "D2", "context", "relates", 0.5);
    repo.link("D2", "context", "D3", "context", "relates", 0.5);
    repo.link("D2", "context", "D1", "context", "relates", 0.5); // back-edge

    const r = repo.getRelated("D1", "context", 2);
    const ids = r.map((n) => n.id).sort();
    expect(ids).toContain("D2");
    expect(ids).toContain("D3");
    expect(r.find((n) => n.id === "D1")).toBeUndefined(); // seed never returned
  });
});

describe("M-05 backfill from derived_from + linkRelated hook", () => {
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

  const BACKFILL_SQL = `INSERT OR IGNORE INTO memory_edges
       (src_id, src_layer, dst_id, dst_layer, kind, weight, created_at)
     SELECT je.value, 'context', c.id, 'context', 'derives', 1.0, c.created_at
     FROM layer2_context c, json_each(COALESCE(c.derived_from, '[]')) je
     WHERE c.derived_from <> '[]' AND je.value <> ''`;

  test("backfill: derived_from JSON → kind='derives' edges", () => {
    memory.insertContext("c-src1", "src 1", "alpha content", "");
    memory.insertContext("c-src2", "src 2", "beta content", "");
    memory.db
      .query(
        `INSERT INTO layer2_context (id, title, content, tags, derived_from)
         VALUES ('c-dst1', 'derived row', 'gamma', '', '["c-src1","c-src2"]')`,
      )
      .run();
    memory.db.query(BACKFILL_SQL).run();
    const inb = memory.getEdgesToDst("c-dst1", "context", ["derives"]);
    expect(inb.length).toBe(2);
    const srcs = inb.map((e) => e.src_id).sort();
    expect(srcs).toEqual(["c-src1", "c-src2"]);
  });

  test("backfill is idempotent under PK constraint", () => {
    const before = memory.db
      .query<{ c: number }, []>("SELECT count(*) AS c FROM memory_edges WHERE kind='derives'")
      .get()?.c;
    memory.db.query(BACKFILL_SQL).run();
    const after = memory.db
      .query<{ c: number }, []>("SELECT count(*) AS c FROM memory_edges WHERE kind='derives'")
      .get()?.c;
    expect(after).toBe(before);
  });

  test("linkRelated draws ≤3 'relates' edges to vec neighbours, skipping self", async () => {
    for (let i = 0; i < 4; i++) {
      const id = `seed-${i}`;
      memory.insertContext(id, `seed ${i}`, `seed content ${i} alpha beta`, "");
      memory.upsertEmbedding(id, "context", fakeEmbed(`seed content ${i}`));
    }
    const r = await writeContext(
      memory,
      rag,
      mkRouter(),
      {
        category: "decision",
        content: "seed content NEW alpha beta gamma",
        tags: "",
        confidence: 0.9,
      },
      "req-link-1",
      log,
    );
    expect(r.ok).toBe(true);
    const insertedId = r.id!;
    const out = memory.getEdgesFromSrc(insertedId, "context", ["relates"]);
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out.length).toBeLessThanOrEqual(3);
    expect(out.find((e) => e.dst_id === insertedId)).toBeUndefined();
    for (const e of out) expect(e.kind).toBe("relates");
  });

  test("linkRelated swallows errors → write still ok if RAG fails", async () => {
    const original = rag.search.bind(rag);
    (rag as any).search = async () => {
      throw new Error("simulated RAG failure");
    };
    try {
      const r = await writeContext(
        memory,
        rag,
        mkRouter(),
        {
          category: "decision",
          content: "rag fail fact for linkRelated",
          tags: "",
          confidence: 0.9,
        },
        "req-link-fail-1",
        log,
      );
      expect(r.ok).toBe(true);
    } finally {
      (rag as any).search = original;
    }
  });
});
