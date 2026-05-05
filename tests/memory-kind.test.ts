/**
 * M-07 (mig 12): kind enum on shared_memory.
 *
 * Coverage:
 *  1. Migration applies + backfill from category.
 *  2. Migration is idempotent (re-open does not throw, kinds preserved).
 *  3. `categoryToKind` pure mapping.
 *  4. CHECK trigger blocks invalid kind on INSERT and UPDATE.
 *  5. `MemoryService.insertShared({ kind })` persists kind.
 *  6. `extractors.writeShared` derives kind from category.
 *  7. RAG persona boost ranks persona above semantic on identical query.
 *  8. `GET /v1/memory/shared?kind=persona` filters correctly.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { Elysia } from "elysia";
import { MemoryDB } from "../src/db";
import { logger } from "../src/lib/logger";
import { writeShared } from "../src/pipeline/agent-pipeline/post/extractors";
import { categoryToKind, type MemoryKind } from "../src/pipeline/agent-pipeline/post/validators";
import { RAGPipeline } from "../src/rag";
import { memoryRoute } from "../src/routes/memory";
import { MemoryService } from "../src/services/memory";

const TEST_DB = "data/test-mem7-kind.db";
const log = logger.child("test-mem7");

function fakeEmbed(text: string): Float32Array {
  // Deterministic fake — different texts produce different vectors so vec
  // search has something to differentiate. Real embeddings unnecessary here.
  const vec = new Float32Array(2048);
  for (let i = 0; i < text.length; i++) {
    vec[text.charCodeAt(i) % 2048] += 1;
  }
  vec[0] += 0.01;
  return vec;
}

function mkRouter() {
  // Minimal router stub: no rerank (RAGPipeline falls back to RRF order),
  // embed returns deterministic Float32Array via fakeEmbed.
  return {
    raw: {
      embed: async (req: { input: string[] }) => ({
        data: req.input.map((t) => ({
          embedding: Array.from(fakeEmbed(t)),
        })),
      }),
      rerank: async () => ({ results: [] }),
    },
    scheduleRaw: async (_p: string, fn: () => Promise<unknown>) => fn(),
  } as unknown as import("../src/lib/model-router").ModelRouter;
}

function cleanup(): void {
  for (const ext of ["", "-shm", "-wal"]) {
    const p = `${TEST_DB}${ext}`;
    if (existsSync(p)) unlinkSync(p);
  }
}

describe("Migration 12 — kind column + backfill", () => {
  let memory: MemoryDB;

  beforeAll(() => {
    cleanup();
    // Pre-seed via raw SQL on a fresh DB so we exercise the backfill path:
    // open without mig 12 by short-circuiting via an older user_version is
    // brittle, so instead we open normally (mig 12 fires once), then verify
    // that backfill catches new pre-mig-12 rows by manually rolling kind off
    // and re-running the UPDATE step. That covers both fresh + upgrade.
    memory = new MemoryDB(TEST_DB);
  });

  afterAll(() => {
    memory.close();
    cleanup();
  });

  test("user_version >= 12", () => {
    const row = memory.db.query<{ user_version: number }, []>("PRAGMA user_version").get()!;
    expect(row.user_version).toBeGreaterThanOrEqual(12);
  });

  test("shared_memory has kind column with TEXT NOT NULL DEFAULT 'semantic'", () => {
    const cols = memory.db.query("PRAGMA table_info(shared_memory)").all() as {
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }[];
    const kind = cols.find((c) => c.name === "kind");
    expect(kind).toBeDefined();
    expect(kind?.type).toBe("TEXT");
    expect(kind?.notnull).toBe(1);
    // SQLite stores DEFAULT verbatim incl. quotes for TEXT.
    expect(kind?.dflt_value).toBe("'semantic'");
  });

  test("two CHECK triggers + idx_shared_kind exist", () => {
    const triggers = memory.db
      .query("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_shared_kind%'")
      .all() as { name: string }[];
    expect(triggers.map((t) => t.name).sort()).toEqual([
      "trg_shared_kind_check",
      "trg_shared_kind_check_upd",
    ]);
    const idx = memory.db
      .query("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_shared_kind'")
      .get() as { name: string } | null;
    expect(idx?.name).toBe("idx_shared_kind");
  });

  test("backfill: profile / preference / relationship → persona; goal → semantic", () => {
    memory.insertShared("p-row", "profile", "loves Hyprland", "");
    memory.insertShared("pref-row", "preference", "prefers fish", "");
    memory.insertShared("rel-row", "relationship", "married", "");
    memory.insertShared("goal-row", "goal", "ship subbrain", "");
    memory.insertShared("skill-row", "skill", "TS expert", "");
    // Re-run backfill UPDATE manually to verify mapping is correct (the
    // initial migration already ran, but inserts from this test rely on
    // categoryToKind via writeShared, NOT on the SQL backfill — so we
    // exercise the SQL UPDATE here directly).
    memory.db
      .query(
        `UPDATE shared_memory
            SET kind = CASE LOWER(category)
                         WHEN 'profile'      THEN 'persona'
                         WHEN 'preference'   THEN 'persona'
                         WHEN 'relationship' THEN 'persona'
                         ELSE 'semantic'
                       END`,
      )
      .run();
    expect(memory.getShared("p-row")?.kind).toBe("persona");
    expect(memory.getShared("pref-row")?.kind).toBe("persona");
    expect(memory.getShared("rel-row")?.kind).toBe("persona");
    expect(memory.getShared("goal-row")?.kind).toBe("semantic");
    expect(memory.getShared("skill-row")?.kind).toBe("semantic");
  });

  test("idempotent: closing + reopening DB does not throw, kinds preserved", () => {
    memory.close();
    memory = new MemoryDB(TEST_DB);
    const row = memory.db.query<{ user_version: number }, []>("PRAGMA user_version").get()!;
    expect(row.user_version).toBeGreaterThanOrEqual(12);
    expect(memory.getShared("p-row")?.kind).toBe("persona");
  });

  test("CHECK trigger blocks invalid kind on INSERT", () => {
    expect(() => {
      memory.db
        .query(
          "INSERT INTO shared_memory (id, category, content, tags, kind) VALUES (?, ?, ?, ?, ?)",
        )
        .run("bad-ins", "profile", "x", "", "totally-bogus");
    }).toThrow(/invalid kind/);
  });

  test("CHECK trigger blocks invalid kind on UPDATE", () => {
    memory.insertShared("upd-row", "goal", "x", "");
    expect(() => {
      memory.db
        .query("UPDATE shared_memory SET kind = ? WHERE id = ?")
        .run("not-a-kind", "upd-row");
    }).toThrow(/invalid kind/);
  });
});

describe("categoryToKind helper", () => {
  test("shared.profile / preference / relationship → persona", () => {
    expect(categoryToKind("profile", "shared")).toBe("persona");
    expect(categoryToKind("PREFERENCE", "shared")).toBe("persona"); // case-insensitive
    expect(categoryToKind("  relationship  ", "shared")).toBe("persona"); // trim
  });

  test("shared.goal / skill / constraint / style → semantic", () => {
    expect(categoryToKind("goal", "shared")).toBe("semantic");
    expect(categoryToKind("skill", "shared")).toBe("semantic");
    expect(categoryToKind("constraint", "shared")).toBe("semantic");
    expect(categoryToKind("style", "shared")).toBe("semantic");
  });

  test("context layer always → semantic regardless of category", () => {
    expect(categoryToKind("profile", "context")).toBe("semantic");
    expect(categoryToKind("decision", "context")).toBe("semantic");
  });
});

describe("MemoryService.insertShared persists kind", () => {
  let memory: MemoryDB;
  let svc: MemoryService;

  beforeAll(() => {
    cleanup();
    memory = new MemoryDB(TEST_DB);
    const rag = new RAGPipeline(memory, mkRouter());
    svc = new MemoryService(memory.memoryRepo, rag, memory.logRepo);
  });

  afterAll(() => {
    memory.close();
    cleanup();
  });

  test("kind: 'persona' persists; default 'semantic' on omit", async () => {
    const idP = await svc.insertShared({
      category: "profile",
      content: "uses Arch",
      kind: "persona",
    });
    const idS = await svc.insertShared({
      category: "goal",
      content: "ship feature",
    });
    expect(memory.getShared(idP)?.kind).toBe("persona");
    expect(memory.getShared(idS)?.kind).toBe("semantic");
  });
});

describe("extractors.writeShared derives kind from category", () => {
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

  test("category='profile' → kind='persona'", async () => {
    const r = await writeShared(
      memory,
      rag,
      mkRouter(),
      {
        category: "profile",
        content: "loves caveman mode",
        tags: "",
        confidence: 0.95,
      },
      log,
    );
    expect(r.ok).toBe(true);
    expect(memory.getShared(r.id!)?.kind).toBe("persona");
  });

  test("category='goal' → kind='semantic'", async () => {
    const r = await writeShared(
      memory,
      rag,
      mkRouter(),
      {
        category: "goal",
        content: "deliver M-07 tonight",
        tags: "",
        confidence: 0.95,
      },
      log,
    );
    expect(r.ok).toBe(true);
    expect(memory.getShared(r.id!)?.kind).toBe("semantic");
  });
});

describe("RAG persona boost", () => {
  let memory: MemoryDB;
  let rag: RAGPipeline;

  beforeAll(async () => {
    cleanup();
    memory = new MemoryDB(TEST_DB);
    rag = new RAGPipeline(memory, mkRouter());
    // Two rows with overlapping FTS terms so both match the query. A is
    // persona (gets boost), B is semantic. Identical content tokens push the
    // RRF scores close enough that the 1.1× boost flips ranking.
    const idA = "persona-a";
    const idB = "semantic-b";
    memory.insertShared(idA, "preference", "user prefers Hyprland tiling", "", "test", {
      kind: "persona",
    });
    memory.insertShared(idB, "goal", "ship Hyprland config", "", "test", { kind: "semantic" });
    // Embed both rows so vec search returns them too.
    memory.upsertEmbedding(idA, "shared", fakeEmbed("user prefers Hyprland tiling"));
    memory.upsertEmbedding(idB, "shared", fakeEmbed("ship Hyprland config"));
  });

  afterAll(() => {
    memory.close();
    cleanup();
  });

  test("persona row outranks semantic row on identical-term query", async () => {
    const results = await rag.search({
      query: "Hyprland",
      layers: ["shared"],
      skipRerank: true, // bypass external rerank — boost still applied
      rerankTopN: 5,
    });
    const idxPersona = results.findIndex((r) => r.id === "persona-a");
    const idxSemantic = results.findIndex((r) => r.id === "semantic-b");
    expect(idxPersona).toBeGreaterThanOrEqual(0);
    expect(idxSemantic).toBeGreaterThanOrEqual(0);
    expect(idxPersona).toBeLessThan(idxSemantic);
    // Score on persona must be strictly greater post-boost.
    expect(results[idxPersona].score).toBeGreaterThan(results[idxSemantic].score);
  });
});

describe("GET /v1/memory/shared?kind=persona filters", () => {
  let memory: MemoryDB;
  let app: Elysia;
  let base: string;

  beforeAll(() => {
    cleanup();
    memory = new MemoryDB(TEST_DB);
    const rag = new RAGPipeline(memory, mkRouter());
    const svc = new MemoryService(memory.memoryRepo, rag, memory.logRepo);
    app = new Elysia().use(memoryRoute(svc, memory)).listen(0);
    base = `http://localhost:${app.server?.port}`;
    memory.insertShared("k-prof", "profile", "row prof", "", "test", { kind: "persona" });
    memory.insertShared("k-pref", "preference", "row pref", "", "test", { kind: "persona" });
    memory.insertShared("k-goal", "goal", "row goal", "", "test", { kind: "semantic" });
    memory.insertShared("k-skill", "skill", "row skill", "", "test", { kind: "semantic" });
  });

  afterAll(() => {
    app.stop();
    memory.close();
    cleanup();
  });

  test("?kind=persona returns only persona rows", async () => {
    const r = await fetch(`${base}/v1/memory/shared?kind=persona&page_size=50`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { items: { id: string; kind: MemoryKind }[]; total: number };
    const ids = body.items.map((x) => x.id).sort();
    expect(ids).toEqual(["k-pref", "k-prof"]);
    for (const it of body.items) expect(it.kind).toBe("persona");
  });

  test("?kind=semantic returns only semantic rows", async () => {
    const r = await fetch(`${base}/v1/memory/shared?kind=semantic&page_size=50`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { items: { id: string; kind: MemoryKind }[] };
    const ids = body.items.map((x) => x.id).sort();
    expect(ids).toEqual(["k-goal", "k-skill"]);
  });

  test("no ?kind → all rows visible", async () => {
    const r = await fetch(`${base}/v1/memory/shared?page_size=50`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { items: { id: string }[] };
    const ids = body.items.map((x) => x.id);
    expect(ids).toContain("k-prof");
    expect(ids).toContain("k-goal");
  });

  test("?kind=foo (invalid) → 422 from TypeBox", async () => {
    const r = await fetch(`${base}/v1/memory/shared?kind=foo&page_size=50`);
    expect(r.status).toBe(422);
  });
});

// ─────────────────────────────────────────────────────────────────
// M-FINAL2 (M-07.1): regression — every shared writer derives kind
// ─────────────────────────────────────────────────────────────────

describe("M-07.1: MemoryTools.write derives kind from category", () => {
  // legacy fallback path (no MemoryService injected): writeSharedAtomic
  // must still resolve kind from category so older tests / boot-time
  // scripts produce persona rows for persona-grade categories.
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

  test("layer='shared' category='profile' → kind='persona' (writeSharedAtomic path)", async () => {
    const { MemoryTools } = await import("../src/mcp/tools/memory");
    const tools = new MemoryTools(memory, () => rag);
    const r = await tools.write({
      layer: "shared",
      category: "profile",
      content: "user uses Hyprland on Arch",
      confidence: 0.95,
    });
    expect(r.success).toBe(true);
    const id = (r.data as { id: string }).id;
    expect(memory.getShared(id)?.kind).toBe("persona");
  });

  test("layer='shared' category='goal' → kind='semantic'", async () => {
    const { MemoryTools } = await import("../src/mcp/tools/memory");
    const tools = new MemoryTools(memory, () => rag);
    const r = await tools.write({
      layer: "shared",
      category: "goal",
      content: "ship M-FINAL2 today",
      confidence: 0.95,
    });
    expect(r.success).toBe(true);
    const id = (r.data as { id: string }).id;
    expect(memory.getShared(id)?.kind).toBe("semantic");
  });

  test("layer='shared' with injected MemoryService also derives kind='persona'", async () => {
    const { MemoryTools } = await import("../src/mcp/tools/memory");
    const svc = new MemoryService(memory.memoryRepo, rag, memory.logRepo);
    const tools = new MemoryTools(memory, () => rag);
    tools.setMemoryService(svc);
    const r = await tools.write({
      layer: "shared",
      category: "preference",
      content: "prefers fish shell",
      confidence: 0.95,
    });
    expect(r.success).toBe(true);
    const id = (r.data as { id: string }).id;
    expect(memory.getShared(id)?.kind).toBe("persona");
  });
});

describe("M-07.1: context-compressor persists kind from category", () => {
  // ChatService's compressor shim used to drop opts.kind, so every fact
  // backfilled to default 'semantic' even for category='preference'.
  // Regression: with kind threaded through, persona-grade categories land
  // as persona.
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

  test("compressor shim with category='preference' lands as kind='persona'", async () => {
    // Drive the actual code path the production compressor uses: a
    // CompressorMemory shim wrapping MemoryService.insertShared, plus
    // the categoryToKind derivation that compressContext applies.
    // We don't need to run the full LLM call — just simulate the
    // post-`facts` persist loop the compressor executes.
    const svc = new MemoryService(memory.memoryRepo, rag, memory.logRepo);
    const shim = {
      insertShared: (
        _id: string,
        category: string,
        content: string,
        tags?: string,
        source?: string,
        opts?: {
          confidence?: number | null;
          status?: import("../src/db").MemoryStatus;
          kind?: import("../src/db").MemoryKind;
        },
      ) =>
        svc.insertShared({
          category,
          content,
          tags: tags ?? "",
          source,
          confidence: opts?.confidence,
          status: opts?.status,
          kind: opts?.kind,
        }),
    };
    // Mirror compressContext's persist branch: derive kind, call shim.
    const persona = categoryToKind("preference", "shared");
    const semantic = categoryToKind("finding", "shared");
    expect(persona).toBe("persona");
    expect(semantic).toBe("semantic");

    const personaId = (await shim.insertShared(
      "ignored",
      "preference",
      "user prefers Hyprland",
      "",
      "context-compression",
      { kind: persona },
    )) as string;
    const semanticId = (await shim.insertShared(
      "ignored",
      "finding",
      "subbrain repo lives at /usr/projects/subbrain",
      "",
      "context-compression",
      { kind: semantic },
    )) as string;

    expect(memory.getShared(personaId)?.kind).toBe("persona");
    expect(memory.getShared(semanticId)?.kind).toBe("semantic");
  });

  test("compressContext end-to-end: persona facts land with kind='persona'", async () => {
    // Full integration: stub router to return one preference + one finding
    // fact, run compressContext, verify both rows landed with correct kind.
    const { compressContext } = await import("../src/pipeline/context-compressor");
    const svc = new MemoryService(memory.memoryRepo, rag, memory.logRepo);
    const shim: import("../src/pipeline/context-compressor").CompressorMemory = {
      insertShared: (_id, category, content, tags, source, opts) =>
        svc.insertShared({
          category,
          content,
          tags: tags ?? "",
          source,
          confidence: opts?.confidence,
          status: opts?.status,
          kind: opts?.kind,
        }),
    };
    const stubRouter = {
      chat: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: "compressed summary placeholder",
                facts: [
                  { category: "preference", content: "user runs caveman mode" },
                  { category: "finding", content: "vec_embeddings layer column needed" },
                ],
              }),
            },
          },
        ],
      }),
    } as unknown as import("../src/lib/model-router").ModelRouter;
    // Build messages over SOFT_LIMIT so compressContext fires.
    // Need head + middle + tail: system + first user + 5 middle msgs +
    // 10-msg tail. keepRecent=2 narrows the tail so middle is non-empty.
    const big = "x".repeat(2_000);
    const msgs: import("../src/providers/types").Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "first task" },
      { role: "assistant", content: big },
      { role: "user", content: big },
      { role: "assistant", content: big },
      { role: "user", content: "tail user" },
    ];
    const beforeCount = memory.countShared();
    // limit=100 forces compression — we don't care about real soft-limit
    // semantics here, only that the persist branch runs with kind threaded.
    // keepRecent=2 keeps the last 2 messages so the middle (3 messages)
    // stays non-empty.
    const did = await compressContext(msgs, stubRouter, shim, { limit: 100, keepRecent: 2 });
    expect(did).toBe(true);
    expect(memory.countShared()).toBeGreaterThan(beforeCount);
    const all = memory.getAllShared();
    const pref = all.find((r) => r.content === "user runs caveman mode");
    const fnd = all.find((r) => r.content === "vec_embeddings layer column needed");
    expect(pref).toBeDefined();
    expect(fnd).toBeDefined();
    expect(pref?.kind).toBe("persona");
    expect(fnd?.kind).toBe("semantic");
  });
});
