/**
 * M-05.2: LLM contradiction detection on linkRelated.
 *
 * After relates-loop + tag-evolution, linkRelated optionally calls
 * `router.chat(<role>, ...)` with the inserted content + drawn-neighbour
 * candidates and parses a JSON verdict. Verdicts above `LINK_CONTRADICT_MIN_CONF`
 * draw a `contradicts` edge from inserted → candidate.
 *
 * These tests exercise the full pipeline (writeContext / writeShared) but mock
 * the LLM call by stubbing `router.chat`. RAG embed/rerank uses the same
 * fakeEmbed pattern as M-05.1 so neighbours are deterministic. Each test
 * uses a fresh DB + a distinct WHITELIST category so dedupe never fires.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { MemoryDB } from "../src/db";
import { writeContext, writeShared } from "../src/pipeline/agent-pipeline/post/extractors";
import { RAGPipeline } from "../src/rag";

const TEST_DB = "data/test-mem5.2-contradict.db";

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

/**
 * Mock router that:
 *  - implements `raw.embed/rerank` for RAGPipeline (always neighbour-cosine)
 *  - implements `chat()` returning a hardcoded JSON string
 *  - counts `chat()` invocations for "no LLM call" assertions
 *  - stub `scheduleRaw` to bypass rate-limiter
 */
function mkRouter(chatBody: string | null = null) {
  const calls = { chat: 0 };
  const router: any = {
    raw: {
      embed: async (req: { input: string[] }) => ({
        data: req.input.map((t) => ({ embedding: Array.from(fakeEmbed(t)) })),
      }),
      rerank: async () => ({ results: [] }),
    },
    scheduleRaw: async (_p: string, fn: () => Promise<any>) => fn(),
    chat: async () => {
      calls.chat++;
      if (chatBody === null) throw new Error("chat() not stubbed");
      return {
        id: "mock",
        object: "chat.completion",
        created: 0,
        model: "mock",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: chatBody },
            finish_reason: "stop",
          },
        ],
      };
    },
  };
  return { router, calls };
}

function cleanup() {
  for (const ext of ["", "-shm", "-wal"]) {
    const p = `${TEST_DB}${ext}`;
    if (existsSync(p)) unlinkSync(p);
  }
}

describe("M-05.2 LLM contradiction detection on linkRelated", () => {
  let memory: MemoryDB;
  let rag: RAGPipeline;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    cleanup();
    mkdirSync("data", { recursive: true });
    memory = new MemoryDB(TEST_DB);
    // Default rag fed a router with an embed-only stub (no chat needed).
    rag = new RAGPipeline(memory, mkRouter('{"contradicts":[]}').router);
    savedEnv = {
      LINK_CONTRADICT_ENABLED: process.env.LINK_CONTRADICT_ENABLED,
      LINK_CONTRADICT_MIN_CONF: process.env.LINK_CONTRADICT_MIN_CONF,
    };
    delete process.env.LINK_CONTRADICT_ENABLED;
    delete process.env.LINK_CONTRADICT_MIN_CONF;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    memory.close();
    cleanup();
  });

  // Seed a context-layer neighbour with embedding matching `content` so RAG
  // surfaces it as the top-N hit for any later writeContext on similar text.
  function seedContext(id: string, content: string, tags: string = "") {
    memory.insertContext(id, `seed-${id}`, content, tags);
    memory.upsertEmbedding(id, "context", fakeEmbed(content));
  }
  function seedShared(id: string, content: string) {
    memory.insertShared(id, "preference", content, "", "post-processing", {
      confidence: 0.9,
      status: "active",
      kind: "persona",
    });
    memory.upsertEmbedding(id, "shared", fakeEmbed(content));
  }

  function contradictsEdges(srcId: string, srcLayer: "context" | "shared") {
    return memory.getEdgesFromSrc(srcId, srcLayer, ["contradicts"]);
  }

  test("1. disabled by default → no chat call, no contradicts edges", async () => {
    seedContext("c1-seed", "user prefers dark mode test-disabled");
    const { router, calls } = mkRouter('{"contradicts":[]}');
    const r = await writeContext(
      memory,
      rag,
      router,
      {
        category: "decision",
        content: "user prefers dark mode test-disabled too",
        tags: "",
        confidence: 0.9,
      },
      "req-c1",
      log,
    );
    expect(r.ok).toBe(true);
    expect(calls.chat).toBe(0);
    expect(contradictsEdges(r.id!, "context").length).toBe(0);
  });

  test("2. enabled, no contradiction → relates drawn but no contradicts", async () => {
    process.env.LINK_CONTRADICT_ENABLED = "true";
    seedContext("c2-seed", "alpha beta gamma test-no-contra");
    const { router, calls } = mkRouter('{"contradicts":[]}');
    const r = await writeContext(
      memory,
      rag,
      router,
      {
        category: "bug",
        content: "alpha beta gamma test-no-contra plus delta",
        tags: "",
        confidence: 0.9,
      },
      "req-c2",
      log,
    );
    expect(r.ok).toBe(true);
    expect(calls.chat).toBe(1);
    expect(contradictsEdges(r.id!, "context").length).toBe(0);
    // relates edge should still exist.
    const rel = memory.getEdgesFromSrc(r.id!, "context", ["relates"]);
    expect(rel.length).toBeGreaterThanOrEqual(1);
  });

  test("3. enabled, single contradiction above threshold → one contradicts edge", async () => {
    process.env.LINK_CONTRADICT_ENABLED = "true";
    seedContext("c3-seed", "epsilon zeta eta test-strong-contra");
    const body = JSON.stringify({
      contradicts: [{ id: "c3-seed", confidence: 0.9 }],
    });
    const { router, calls } = mkRouter(body);
    const r = await writeContext(
      memory,
      rag,
      router,
      {
        category: "architecture",
        content: "epsilon zeta eta test-strong-contra plus theta",
        tags: "",
        confidence: 0.9,
      },
      "req-c3",
      log,
    );
    expect(r.ok).toBe(true);
    expect(calls.chat).toBe(1);
    const edges = contradictsEdges(r.id!, "context");
    expect(edges.length).toBe(1);
    expect(edges[0]?.dst_id).toBe("c3-seed");
    expect(edges[0]?.weight).toBeCloseTo(0.9, 5);
  });

  test("4. confidence below threshold filtered → no edge", async () => {
    process.env.LINK_CONTRADICT_ENABLED = "true";
    process.env.LINK_CONTRADICT_MIN_CONF = "0.7";
    seedContext("c4-seed", "iota kappa lambda test-low-conf");
    const body = JSON.stringify({
      contradicts: [{ id: "c4-seed", confidence: 0.3 }],
    });
    const { router, calls } = mkRouter(body);
    const r = await writeContext(
      memory,
      rag,
      router,
      {
        category: "learning",
        content: "iota kappa lambda test-low-conf plus mu",
        tags: "",
        confidence: 0.9,
      },
      "req-c4",
      log,
    );
    expect(r.ok).toBe(true);
    expect(calls.chat).toBe(1);
    expect(contradictsEdges(r.id!, "context").length).toBe(0);
  });

  test("5. malformed JSON → no throw, no edges", async () => {
    process.env.LINK_CONTRADICT_ENABLED = "true";
    seedContext("c5-seed", "nu xi omicron test-bad-json");
    const { router, calls } = mkRouter("not json blah");
    const r = await writeContext(
      memory,
      rag,
      router,
      {
        category: "project",
        content: "nu xi omicron test-bad-json plus pi",
        tags: "",
        confidence: 0.9,
      },
      "req-c5",
      log,
    );
    expect(r.ok).toBe(true);
    expect(calls.chat).toBe(1);
    expect(contradictsEdges(r.id!, "context").length).toBe(0);
  });

  test("6. hallucinated id → ignored silently", async () => {
    process.env.LINK_CONTRADICT_ENABLED = "true";
    seedContext("c6-seed", "rho sigma tau test-hallu");
    const body = JSON.stringify({
      contradicts: [{ id: "non-existent-id-xyz", confidence: 0.95 }],
    });
    const { router, calls } = mkRouter(body);
    const r = await writeContext(
      memory,
      rag,
      router,
      {
        category: "learning",
        content: "rho sigma tau test-hallu plus upsilon",
        tags: "",
        confidence: 0.9,
      },
      "req-c6",
      log,
    );
    expect(r.ok).toBe(true);
    expect(calls.chat).toBe(1);
    expect(contradictsEdges(r.id!, "context").length).toBe(0);
  });

  test("7. drawnNeighbours empty → no LLM call", async () => {
    process.env.LINK_CONTRADICT_ENABLED = "true";
    // No seed → no neighbours → relates-loop draws zero → contradiction
    // detector early-returns before chat().
    const { router, calls } = mkRouter('{"contradicts":[]}');
    const r = await writeContext(
      memory,
      rag,
      router,
      {
        category: "decision",
        content: "phi chi psi test-empty-neighbours plus omega",
        tags: "",
        confidence: 0.9,
      },
      "req-c7",
      log,
    );
    expect(r.ok).toBe(true);
    expect(calls.chat).toBe(0);
    expect(contradictsEdges(r.id!, "context").length).toBe(0);
  });

  test("8. shared layer → contradicts edge between shared rows", async () => {
    process.env.LINK_CONTRADICT_ENABLED = "true";
    seedShared("c8-seed", "user likes coffee test-shared-layer");
    const body = JSON.stringify({
      contradicts: [{ id: "c8-seed", confidence: 0.85 }],
    });
    const { router, calls } = mkRouter(body);
    // Seed category is `preference` — write under `skill` (also in
    // WHITELIST_SHARED) so dedupe-miss path inserts a fresh row and triggers
    // linkRelated. Same-category would token-overlap → merge, no insert.
    const r = await writeShared(
      memory,
      rag,
      router,
      {
        category: "skill",
        content: "user dislikes coffee test-shared-layer reverse",
        tags: "",
        confidence: 0.9,
      },
      log,
    );
    expect(r.ok).toBe(true);
    expect(calls.chat).toBe(1);
    const edges = contradictsEdges(r.id!, "shared");
    expect(edges.length).toBe(1);
    expect(edges[0]?.dst_id).toBe("c8-seed");
    expect(edges[0]?.dst_layer).toBe("shared");
    expect(edges[0]?.weight).toBeCloseTo(0.85, 5);
  });
});
