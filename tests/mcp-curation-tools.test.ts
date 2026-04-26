/**
 * M-10 — agent-only curation MCP tools (memory_link / memory_supersede /
 * memory_promote / memory_reflect). See plan §Тесты.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { MemoryDB } from "../src/db";
import { RAGPipeline } from "../src/rag";
import { MemoryService } from "../src/services/memory.service";
import { MemoryCurationTools } from "../src/mcp/tools/memory-curation-tools";

const TEST_DB = "data/test-mem10-curation.db";

function cleanup(): void {
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

function makeRouter(reply: string): {
  router: any;
  calls: () => number;
} {
  let chatCalls = 0;
  const router: any = {
    raw: {
      embed: async (req: { input: string[] }) => ({
        data: req.input.map((t) => ({ embedding: Array.from(fakeEmbed(t)) })),
      }),
      rerank: async () => ({ results: [] }),
    },
    scheduleRaw: async (_p: string, fn: () => Promise<any>) => fn(),
    chat: async () => {
      chatCalls++;
      return { choices: [{ message: { content: reply } }] };
    },
  };
  return { router, calls: () => chatCalls };
}

function seedContext(memory: MemoryDB, id: string, title: string, content: string, access = 5): void {
  memory.insertContext(id, title, content, "");
  const past = Math.floor(Date.now() / 1000) - 30 * 60 * 60;
  memory.db
    .query("UPDATE layer2_context SET created_at = ?, access_count = ? WHERE id = ?")
    .run(past, access, id);
  memory.upsertEmbedding(id, "context", fakeEmbed(content));
}

describe("M-10 MemoryCurationTools", () => {
  let memory: MemoryDB;
  let rag: RAGPipeline;
  let svc: MemoryService;
  let tools: MemoryCurationTools;
  let router: any;

  beforeAll(() => cleanup());
  afterAll(() => {
    if (memory) memory.close();
    cleanup();
  });

  beforeEach(() => {
    if (memory) memory.close();
    cleanup();
    memory = new MemoryDB(TEST_DB);
    const { router: r } = makeRouter("Project uses Bun runtime for backend.");
    router = r;
    rag = new RAGPipeline(memory, router);
    svc = new MemoryService(memory.memoryRepo, rag, memory.logRepo);
    tools = new MemoryCurationTools(memory, () => svc, () => rag, () => router);
  });

  // ─── memory_link ────────────────────────────────────────────────

  test("memory_link creates edge between two existing rows", () => {
    memory.insertContext("ctx-a", "decision", "alpha", "");
    memory.insertContext("ctx-b", "decision", "beta", "");
    const r = tools.link({
      src_id: "ctx-a",
      src_layer: "context",
      dst_id: "ctx-b",
      dst_layer: "context",
      kind: "relates",
    });
    expect(r.success).toBe(true);
    expect((r.data as { linked: boolean }).linked).toBe(true);
    const out = memory.getEdgesFromSrc("ctx-a", "context", ["relates"]);
    expect(out.length).toBe(1);
    expect(out[0].dst_id).toBe("ctx-b");
    expect(out[0].weight).toBeCloseTo(1.0, 5);
  });

  test("memory_link idempotent on PK collision", () => {
    memory.insertContext("ctx-a", "x", "a", "");
    memory.insertContext("ctx-b", "x", "b", "");
    const args = {
      src_id: "ctx-a",
      src_layer: "context" as const,
      dst_id: "ctx-b",
      dst_layer: "context" as const,
      kind: "relates" as const,
    };
    const first = tools.link(args);
    const second = tools.link(args);
    expect(first.success).toBe(true);
    expect((first.data as { linked: boolean }).linked).toBe(true);
    expect(second.success).toBe(true);
    expect((second.data as { linked: boolean }).linked).toBe(false);
    expect(memory.getEdgesFromSrc("ctx-a", "context", ["relates"]).length).toBe(1);
  });

  test("memory_link missing src returns success:false", () => {
    memory.insertContext("ctx-b", "x", "b", "");
    const r = tools.link({
      src_id: "ghost",
      src_layer: "context",
      dst_id: "ctx-b",
      dst_layer: "context",
      kind: "relates",
    });
    expect(r.success).toBe(false);
    expect(r.error).toContain("src not found");
  });

  test("memory_link missing dst returns success:false", () => {
    memory.insertContext("ctx-a", "x", "a", "");
    const r = tools.link({
      src_id: "ctx-a",
      src_layer: "context",
      dst_id: "ghost",
      dst_layer: "context",
      kind: "relates",
    });
    expect(r.success).toBe(false);
    expect(r.error).toContain("dst not found");
  });

  // ─── memory_supersede ───────────────────────────────────────────

  test("memory_supersede updates column + writes audit edge (shared)", () => {
    memory.insertShared("sh-old", "project", "old fact", "");
    memory.insertShared("sh-new", "project", "new fact", "");
    const r = tools.supersede({
      old_id: "sh-old",
      old_layer: "shared",
      new_id: "sh-new",
      new_layer: "shared",
    });
    expect(r.success).toBe(true);
    const old = memory.getShared("sh-old");
    expect(old?.superseded_by).toBe("sh-new");
    const edges = memory.getEdgesFromSrc("sh-old", "shared", ["supersedes"]);
    expect(edges.length).toBe(1);
    expect(edges[0].dst_id).toBe("sh-new");
  });

  test("memory_supersede self-supersede forbidden", () => {
    memory.insertShared("sh-1", "project", "fact", "");
    const r = tools.supersede({
      old_id: "sh-1",
      old_layer: "shared",
      new_id: "sh-1",
      new_layer: "shared",
    });
    expect(r.success).toBe(false);
    expect(r.error).toContain("self-supersede");
  });

  test("memory_supersede missing old returns success:false", () => {
    memory.insertShared("sh-new", "project", "new", "");
    const r = tools.supersede({
      old_id: "ghost",
      old_layer: "shared",
      new_id: "sh-new",
      new_layer: "shared",
    });
    expect(r.success).toBe(false);
    expect(r.error).toContain("old not found");
  });

  // ─── memory_promote ─────────────────────────────────────────────

  test("memory_promote context → shared with derives edge", async () => {
    memory.insertContext("ctx-promo", "project", "Pattern X works because Y", "");
    const r = await tools.promote({
      src_id: "ctx-promo",
      src_layer: "context",
      target_layer: "shared",
      category: "skill",
    });
    expect(r.success).toBe(true);
    const newId = (r.data as { id: string }).id;
    const fresh = memory.getShared(newId);
    expect(fresh).not.toBeNull();
    expect(fresh!.source).toBe("promote");
    expect(fresh!.category).toBe("skill");
    expect(fresh!.confidence).toBe(0.8); // M-10 fix-round: explicit autoaccept default
    const edges = memory.getEdgesFromSrc("ctx-promo", "context", ["derives"]);
    expect(edges.length).toBe(1);
    expect(edges[0].dst_id).toBe(newId);
    expect(edges[0].dst_layer).toBe("shared");
  });

  test("memory_promote missing source returns success:false", async () => {
    const r = await tools.promote({
      src_id: "ghost",
      src_layer: "context",
      target_layer: "shared",
      category: "skill",
    });
    expect(r.success).toBe(false);
    expect(r.error).toContain("src not found");
  });

  // ─── memory_reflect ─────────────────────────────────────────────

  test("memory_reflect delegates to runReflect (real promotion)", async () => {
    for (let i = 0; i < 3; i++) {
      seedContext(memory, `pr-${i}`, "project", `Project pattern ${i}`, 5);
    }
    const r = await tools.reflect({});
    expect(r.success).toBe(true);
    const data = r.data as {
      groups_examined: number;
      facts_promoted: number;
      edges_created: number;
      llm_failures: number;
    };
    expect(data.groups_examined).toBe(1);
    expect(data.facts_promoted).toBe(1);
    expect(data.edges_created).toBe(3);
    expect(data.llm_failures).toBe(0);
  });

  test("memory_reflect dryRun does NOT insert shared row", async () => {
    for (let i = 0; i < 3; i++) {
      seedContext(memory, `dr-${i}`, "decision", `Decision ${i} pattern`, 5);
    }
    const r = await tools.reflect({ dryRun: true });
    expect(r.success).toBe(true);
    const data = r.data as {
      groups_examined: number;
      facts_promoted: number;
      edges_created: number;
    };
    expect(data.groups_examined).toBe(1);
    expect(data.facts_promoted).toBe(1);
    expect(data.edges_created).toBe(0);
    const cnt = memory.db
      .query<{ c: number }, []>("SELECT count(*) AS c FROM shared_memory WHERE source = 'reflect'")
      .get()!.c;
    expect(cnt).toBe(0);
  });

  test("memory_reflect categoryFilter narrows to one group", async () => {
    // Mix project + learning; only learning should be examined when filtered.
    for (let i = 0; i < 3; i++) {
      seedContext(memory, `pr-${i}`, "project", `Project ${i} fact`, 5);
      seedContext(memory, `lr-${i}`, "learning", `Learning ${i} insight`, 5);
    }
    const r = await tools.reflect({ category: "learning", dryRun: true });
    expect(r.success).toBe(true);
    const data = r.data as { groups_examined: number };
    expect(data.groups_examined).toBe(1);
  });
});
