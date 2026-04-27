/**
 * M-05.1: A-MEM neighbour tag evolution. After linkRelated draws an edge
 * to a vec neighbour, the neighbour's `tags` CSV absorbs the inserted
 * row's tags (unique, cap-bounded, no LLM). Pure module logic — exercised
 * end-to-end through writeContext / writeShared but verified directly via
 * the seeded neighbour's tags after fan-out.
 *
 * Each test uses a fresh DB + a distinct WHITELIST category so dedupe
 * never fires (cross-category matches are rejected in `findDuplicate`).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync, mkdirSync } from "fs";
import { MemoryDB } from "../src/db";
import { RAGPipeline } from "../src/rag";
import {
  writeContext,
  writeShared,
} from "../src/pipeline/agent-pipeline/post/extractors";

const TEST_DB = "data/test-mem5.1-evolve.db";

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

describe("M-05.1 evolveNeighbour — tag merge on linkRelated", () => {
  let memory: MemoryDB;
  let rag: RAGPipeline;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    cleanup();
    mkdirSync("data", { recursive: true });
    memory = new MemoryDB(TEST_DB);
    rag = new RAGPipeline(memory, mkRouter());
    savedEnv = {
      LINK_EVOLVE_TAGS_ENABLED: process.env.LINK_EVOLVE_TAGS_ENABLED,
      LINK_EVOLVE_MAX_TAGS: process.env.LINK_EVOLVE_MAX_TAGS,
    };
    delete process.env.LINK_EVOLVE_TAGS_ENABLED;
    delete process.env.LINK_EVOLVE_MAX_TAGS;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    memory.close();
    cleanup();
  });

  // Helpers — seed a neighbour with matching embedding so RAG returns it
  // as the top-N hit for any later writeContext / writeShared on the same
  // text shape.
  function seedContext(id: string, content: string, tags: string) {
    memory.insertContext(id, `seed-${id}`, content, tags);
    memory.upsertEmbedding(id, "context", fakeEmbed(content));
  }
  function seedShared(id: string, content: string, tags: string) {
    memory.insertShared(id, "preference", content, tags, "post-processing", {
      confidence: 0.9,
      status: "active",
      kind: "persona",
    });
    memory.upsertEmbedding(id, "shared", fakeEmbed(content));
  }

  test("1. empty inserted tags → neighbour tags unchanged", async () => {
    seedContext("evo-1-seed", "alpha beta gamma test-empty", "x,y,z");
    const r = await writeContext(
      memory,
      rag,
      {
        category: "decision",
        content: "alpha beta gamma test-empty plus delta",
        tags: "",
        confidence: 0.9,
      },
      "req-evo-1",
      log,
    );
    expect(r.ok).toBe(true);
    expect(memory.getContext("evo-1-seed")?.tags).toBe("x,y,z");
  });

  test("2. pure-add merge — a,b + c,d → a,b,c,d", async () => {
    seedContext("evo-2-seed", "epsilon zeta eta test-pureadd", "a,b");
    const r = await writeContext(
      memory,
      rag,
      {
        category: "bug",
        content: "epsilon zeta eta test-pureadd plus theta",
        tags: "c,d",
        confidence: 0.9,
      },
      "req-evo-2",
      log,
    );
    expect(r.ok).toBe(true);
    const tags = (memory.getContext("evo-2-seed")?.tags ?? "").split(",");
    expect(tags).toEqual(["a", "b", "c", "d"]);
  });

  test("3. dup deduplication — current a,b + inserted b,c → a,b,c", async () => {
    seedContext("evo-3-seed", "iota kappa lambda test-dup", "a,b");
    const r = await writeContext(
      memory,
      rag,
      {
        category: "architecture",
        content: "iota kappa lambda test-dup plus mu",
        tags: "b,c",
        confidence: 0.9,
      },
      "req-evo-3",
      log,
    );
    expect(r.ok).toBe(true);
    expect(memory.getContext("evo-3-seed")?.tags).toBe("a,b,c");
  });

  test("4. cap eviction — 10 current + 2 new (cap=10) drops oldest 2", async () => {
    process.env.LINK_EVOLVE_MAX_TAGS = "10";
    const ten = ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9", "t10"].join(",");
    seedContext("evo-4-seed", "nu xi omicron test-cap", ten);
    const r = await writeContext(
      memory,
      rag,
      {
        category: "learning",
        content: "nu xi omicron test-cap plus pi",
        tags: "new1,new2",
        confidence: 0.9,
      },
      "req-evo-4",
      log,
    );
    expect(r.ok).toBe(true);
    const after = (memory.getContext("evo-4-seed")?.tags ?? "").split(",");
    expect(after.length).toBe(10);
    expect(after[0]).toBe("t3");
    expect(after[after.length - 1]).toBe("new2");
    expect(after.includes("t1")).toBe(false);
    expect(after.includes("t2")).toBe(false);
  });

  test("5. no-op when already covered — current a,b,c + inserted a,b → no updated_at bump", async () => {
    seedContext("evo-5-seed", "rho sigma tau test-noop", "a,b,c");
    const before = memory.getContext("evo-5-seed");
    expect(before?.tags).toBe("a,b,c");
    const beforeUpdatedAt = before!.updated_at;

    // Wait > 1s so any UPDATE would shift `updated_at` (unix-seconds).
    await new Promise((res) => setTimeout(res, 1100));

    const r = await writeContext(
      memory,
      rag,
      {
        category: "project",
        content: "rho sigma tau test-noop plus upsilon",
        tags: "a,b",
        confidence: 0.9,
      },
      "req-evo-5",
      log,
    );
    expect(r.ok).toBe(true);
    const after = memory.getContext("evo-5-seed");
    expect(after?.tags).toBe("a,b,c");
    expect(after?.updated_at).toBe(beforeUpdatedAt);
  });

  test("6. layer routing — shared neighbour gets updateShared", async () => {
    seedShared("evo-6-seed", "phi chi psi test-shared-route", "a,b");
    const r = await writeShared(
      memory,
      rag,
      {
        category: "skill",
        content: "phi chi psi test-shared-route plus omega",
        tags: "c,d",
        confidence: 0.9,
      },
      log,
    );
    expect(r.ok).toBe(true);
    const tags = (memory.getShared("evo-6-seed")?.tags ?? "").split(",");
    expect(tags).toEqual(["a", "b", "c", "d"]);
  });

  test("7. LINK_EVOLVE_TAGS_ENABLED=false → skip evolution", async () => {
    process.env.LINK_EVOLVE_TAGS_ENABLED = "false";
    seedContext("evo-7-seed", "aa bb cc test-disabled", "a,b");
    const r = await writeContext(
      memory,
      rag,
      {
        category: "decision",
        content: "aa bb cc test-disabled plus dd",
        tags: "c,d",
        confidence: 0.9,
      },
      "req-evo-7",
      log,
    );
    expect(r.ok).toBe(true);
    expect(memory.getContext("evo-7-seed")?.tags).toBe("a,b");
  });

  test("8. neighbour deleted mid-flight → no throw (linkRelated still ok)", async () => {
    seedContext("evo-8-seed", "ee ff gg test-deleted", "a,b");

    // Simulate a delete between linkEdge and evolveNeighbour by stubbing
    // getContext to return null for the neighbour. linkEdge already ran on
    // the real row, so evolveNeighbour's null-row early-return is the path
    // under test.
    const realGetContext = memory.getContext.bind(memory);
    (memory as any).getContext = (id: string) =>
      id === "evo-8-seed" ? null : realGetContext(id);
    try {
      const r = await writeContext(
        memory,
        rag,
        {
          category: "bug",
          content: "ee ff gg test-deleted plus hh",
          tags: "c,d",
          confidence: 0.9,
        },
        "req-evo-8",
        log,
      );
      expect(r.ok).toBe(true);
    } finally {
      (memory as any).getContext = realGetContext;
    }
    expect(memory.getContext("evo-8-seed")?.tags).toBe("a,b");
  });
});
