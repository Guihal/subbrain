/**
 * M-14: read-only admin surface for `memory_edges` (M-05).
 *
 * Boots an Elysia app with `authMiddleware(AuthService) + memoryRoute(MemoryService)`
 * over a real `MemoryDB` (per-test fresh sqlite at `data/test-mem14-edges.db`).
 * Asserts:
 *   - 401 without Bearer (auth regression)
 *   - GET /v1/memory/edges returns linked edges
 *   - `?kinds=contradicts` filters
 *   - GET /v1/memory/edges/related returns 1-hop neighbours
 *   - empty edges → `{items:[],total:0}` envelope
 *   - invalid `fromLayer` → 422 (TypeBox)
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { Elysia } from "elysia";
import { MemoryDB } from "../src/db";
import { authMiddleware } from "@subbrain/core/lib/auth";
import { AppError } from "../src/lib/errors";
import { RAGPipeline } from "../src/rag";
import { memoryRoute } from "../src/routes/memory";
import { AuthService } from "@subbrain/core/services/auth";
import { MemoryService } from "../src/services/memory";

const TEST_DB = "data/test-mem14-edges.db";
const TOKEN = "test-mem14-edges-token";

function fakeEmbed(text: string): Float32Array {
  const vec = new Float32Array(2048);
  for (let i = 0; i < text.length; i++) vec[text.charCodeAt(i) % 2048] += 1;
  vec[0] += 0.01;
  return vec;
}

function cleanup(): void {
  for (const ext of ["", "-shm", "-wal"]) {
    const p = `${TEST_DB}${ext}`;
    if (existsSync(p)) unlinkSync(p);
  }
}

let memory: MemoryDB;
let app: ReturnType<typeof buildApp>;
let base: string;

function buildApp() {
  memory = new MemoryDB(TEST_DB);
  const router = {
    raw: {
      embed: async (req: { input: string[] }) => ({
        data: req.input.map((t) => ({ embedding: Array.from(fakeEmbed(t)) })),
      }),
      rerank: async () => ({ results: [] }),
    },
    scheduleRaw: async (_p: string, fn: () => Promise<unknown>) => fn(),
  } as unknown as ConstructorParameters<typeof RAGPipeline>[1];
  const rag = new RAGPipeline(memory, router);
  // M-14: pass `memoryDb` (4th arg) so the edges pass-through methods see
  // the live facade. linkDeps left null — no post-hook in tests.
  const svc = new MemoryService(memory.memoryRepo, rag, memory.logRepo, memory);
  const auth = new AuthService(TOKEN);

  return new Elysia()
    .onError(({ code, error, set }) => {
      if (error instanceof AppError) {
        set.status = error.status;
        return { error: { message: error.message, code: error.code } };
      }
      if (code === "VALIDATION") {
        set.status = 422;
        return { error: { message: "validation_error", code: 422 } };
      }
      set.status = 500;
      return { error: { message: "internal" } };
    })
    .use(authMiddleware(auth))
    .use(memoryRoute(svc))
    .listen(0);
}

beforeAll(() => {
  cleanup();
  app = buildApp();
  base = `http://localhost:${app.server?.port}`;

  // Seed: 3 shared rows + edges between them.
  memory.insertShared("src-1", "preference", "source row", "");
  memory.insertShared("dst-1", "preference", "dst row 1", "");
  memory.insertShared("dst-2", "preference", "dst row 2", "");

  // src-1 -[relates]-> dst-1   (weight 1.0)
  memory.linkEdge("src-1", "shared", "dst-1", "shared", "relates", 1.0);
  // src-1 -[contradicts]-> dst-2  (weight 0.85)
  memory.linkEdge("src-1", "shared", "dst-2", "shared", "contradicts", 0.85);

  // M-14 fixup: archive layer regression seed. Use isolated `arc-target`
  // shared row so the new edge doesn't inflate counts on the existing
  // src-1/dst-* graph (production-shape: cross-layer-dedup writes
  // archive→shared `derives` during night-cycle).
  memory.insertShared("arc-target", "preference", "shared row linked from archive", "");
  memory.insertArchive("arc-1", "archived row", "archived content", "", [], 0.7);
  memory.linkEdge("arc-1", "archive", "arc-target", "shared", "derives", 1.0);
});

afterAll(() => {
  app.stop();
  memory.close();
  cleanup();
});

const authHeaders = { Authorization: `Bearer ${TOKEN}` };

describe("routes/memory edges (M-14) — auth", () => {
  test("GET /v1/memory/edges without Bearer → 401", async () => {
    const r = await fetch(`${base}/v1/memory/edges?from=src-1&fromLayer=shared`);
    expect(r.status).toBe(401);
  });

  test("GET /v1/memory/edges/related without Bearer → 401", async () => {
    const r = await fetch(`${base}/v1/memory/edges/related?id=src-1&layer=shared`);
    expect(r.status).toBe(401);
  });
});

describe("routes/memory edges (M-14) — list outbound", () => {
  test("returns both linked edges, newest first", async () => {
    const r = await fetch(`${base}/v1/memory/edges?from=src-1&fromLayer=shared`, {
      headers: authHeaders,
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      items: { src_id: string; dst_id: string; kind: string; weight: number }[];
      total: number;
    };
    expect(body.total).toBe(2);
    const kinds = body.items.map((e) => e.kind).sort();
    expect(kinds).toEqual(["contradicts", "relates"]);
    const dsts = body.items.map((e) => e.dst_id).sort();
    expect(dsts).toEqual(["dst-1", "dst-2"]);
  });

  test("?kinds=contradicts filters by kind", async () => {
    const r = await fetch(`${base}/v1/memory/edges?from=src-1&fromLayer=shared&kinds=contradicts`, {
      headers: authHeaders,
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      items: { kind: string; dst_id: string }[];
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.items[0].kind).toBe("contradicts");
    expect(body.items[0].dst_id).toBe("dst-2");
  });

  test("row with no edges → empty envelope", async () => {
    const r = await fetch(`${base}/v1/memory/edges?from=dst-1&fromLayer=shared`, {
      headers: authHeaders,
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { items: unknown[]; total: number };
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
  });

  test("invalid fromLayer → 422 (TypeBox)", async () => {
    const r = await fetch(`${base}/v1/memory/edges?from=src-1&fromLayer=bogus`, {
      headers: authHeaders,
    });
    expect(r.status).toBe(422);
  });

  test("missing required `from` → 422 (TypeBox)", async () => {
    const r = await fetch(`${base}/v1/memory/edges?fromLayer=shared`, { headers: authHeaders });
    expect(r.status).toBe(422);
  });
});

describe("routes/memory edges (M-14) — list related", () => {
  test("returns 1-hop neighbours via outbound + inbound", async () => {
    // src-1 has 2 outbound edges → 2 neighbours.
    const r = await fetch(`${base}/v1/memory/edges/related?id=src-1&layer=shared`, {
      headers: authHeaders,
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      items: { id: string; layer: string; kind: string; weight: number }[];
      total: number;
    };
    expect(body.total).toBe(2);
    const ids = body.items.map((e) => e.id).sort();
    expect(ids).toEqual(["dst-1", "dst-2"]);
    expect(body.items.every((e) => e.layer === "shared")).toBe(true);
  });

  test("inbound: dst-2 sees src-1 as neighbour via contradicts edge", async () => {
    const r = await fetch(`${base}/v1/memory/edges/related?id=dst-2&layer=shared`, {
      headers: authHeaders,
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      items: { id: string; kind: string }[];
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.items[0].id).toBe("src-1");
    expect(body.items[0].kind).toBe("contradicts");
  });

  test("?kinds=relates narrows to a single neighbour", async () => {
    const r = await fetch(`${base}/v1/memory/edges/related?id=src-1&layer=shared&kinds=relates`, {
      headers: authHeaders,
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { items: { id: string }[]; total: number };
    expect(body.total).toBe(1);
    expect(body.items[0].id).toBe("dst-1");
  });
});

describe("routes/memory edges (M-14 fixup)", () => {
  test("?kinds=foo,bar (all-invalid) → empty envelope, NOT silently unfiltered", async () => {
    // Pre-fixup bug: parseKindsCsv returned undefined → service treated as
    // "no filter" → returned all 2 edges from src-1. After fixup: kinds=[]
    // sentinel triggers route short-circuit → 0 results.
    const r = await fetch(`${base}/v1/memory/edges?from=src-1&fromLayer=shared&kinds=foo,bar`, {
      headers: authHeaders,
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { items: unknown[]; total: number };
    expect(body.total).toBe(0);
    expect(body.items).toEqual([]);
  });

  test("archive layer: outbound derives edge surfaces", async () => {
    const r = await fetch(`${base}/v1/memory/edges?from=arc-1&fromLayer=archive`, {
      headers: authHeaders,
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      items: { src_id: string; dst_id: string; kind: string }[];
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.items[0].src_id).toBe("arc-1");
    expect(body.items[0].dst_id).toBe("arc-target");
    expect(body.items[0].kind).toBe("derives");
  });
});
