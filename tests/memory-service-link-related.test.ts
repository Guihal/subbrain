/**
 * M-13: MemoryService.insertShared / insertContext post-hook calling
 * linkRelated after the transactional embed-first write. Behaviour matches
 * `extractors.writeShared/writeContext` (M-05/M-05.1/M-05.2 chain) but is
 * driven from MemoryService so MCP `memory_write`, night-cycle promotions,
 * and admin REST POST all gain edges.
 *
 * Test approach mirrors `tests/post-link-related-evolution.test.ts`: real
 * MemoryDB + real RAGPipeline with a fakeEmbed-backed router stub, fresh DB
 * per test.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync, mkdirSync } from "fs";
import { MemoryDB } from "../src/db";
import { RAGPipeline } from "../src/rag";
import { MemoryService } from "../src/services/memory";

const TEST_DB = "data/test-mem13-link.db";

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
    chat: async () => ({ choices: [{ message: { content: "{\"contradicts\":[]}" } }] }),
  } as any;
}

function mkThrowingRouter() {
  return {
    raw: {
      embed: async (req: { input: string[] }) => ({
        data: req.input.map((t) => ({ embedding: Array.from(fakeEmbed(t)) })),
      }),
      rerank: async () => ({ results: [] }),
    },
    scheduleRaw: async (_p: string, fn: () => Promise<any>) => fn(),
    chat: async () => { throw new Error("router_down"); },
  } as any;
}

function cleanup() {
  for (const ext of ["", "-shm", "-wal"]) {
    const p = `${TEST_DB}${ext}`;
    if (existsSync(p)) unlinkSync(p);
  }
}

describe("M-13 MemoryService → linkRelated post-hook", () => {
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
      LINK_CONTRADICT_ENABLED: process.env.LINK_CONTRADICT_ENABLED,
    };
    delete process.env.LINK_EVOLVE_TAGS_ENABLED;
    delete process.env.LINK_CONTRADICT_ENABLED;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    memory.close();
    cleanup();
  });

  function seedShared(id: string, content: string, tags: string) {
    memory.insertShared(id, "preference", content, tags, "post-processing", {
      confidence: 0.9,
      status: "active",
      kind: "persona",
    });
    memory.upsertEmbedding(id, "shared", fakeEmbed(content));
  }
  function seedContext(id: string, content: string, tags: string) {
    memory.insertContext(id, `seed-${id}`, content, tags);
    memory.upsertEmbedding(id, "context", fakeEmbed(content));
  }

  test("1. no linkDeps → no edges from new shared row", async () => {
    seedShared("m13-1-seed", "alpha beta gamma m13 first", "x,y");
    // Legacy 3-arg ctor — back-compat path; post-hook must be a no-op.
    const svc = new MemoryService(memory.memoryRepo, rag, memory.logRepo);
    const newId = await svc.insertShared({
      category: "preference",
      content: "alpha beta gamma m13 first plus delta",
      tags: "p,q",
      source: "test",
      confidence: 0.9,
      status: "active",
      kind: "persona",
    });
    const edges = memory.getEdgesFromSrc(newId, "shared");
    expect(edges.length).toBe(0);
  });

  test("2. with linkDeps + memoryDb → relates edge to neighbour (shared)", async () => {
    seedShared("m13-2-seed", "epsilon zeta eta m13 link-shared", "a,b");
    const router = mkRouter();
    const svc = new MemoryService(
      memory.memoryRepo,
      rag,
      memory.logRepo,
      memory,
      { router, log },
    );
    const newId = await svc.insertShared({
      category: "preference",
      content: "epsilon zeta eta m13 link-shared plus theta",
      tags: "c,d",
      source: "test",
      confidence: 0.9,
      status: "active",
      kind: "persona",
    });
    const edges = memory.getEdgesFromSrc(newId, "shared");
    const relates = edges.filter((e) => e.kind === "relates");
    expect(relates.length).toBeGreaterThanOrEqual(1);
    expect(relates.some((e) => e.dst_id === "m13-2-seed")).toBe(true);
  });

  test("3. tag evolution propagates through service (M-05.1 chain)", async () => {
    seedShared("m13-3-seed", "iota kappa lambda m13 evolve", "a,b");
    const router = mkRouter();
    const svc = new MemoryService(
      memory.memoryRepo,
      rag,
      memory.logRepo,
      memory,
      { router, log },
    );
    await svc.insertShared({
      category: "preference",
      content: "iota kappa lambda m13 evolve plus mu",
      tags: "c,d",
      source: "test",
      confidence: 0.9,
      status: "active",
      kind: "persona",
    });
    const evolved = (memory.getShared("m13-3-seed")?.tags ?? "").split(",");
    expect(evolved).toEqual(["a", "b", "c", "d"]);
  });

  test("4. best-effort: linkRelated throw doesn't abort write", async () => {
    process.env.LINK_CONTRADICT_ENABLED = "true";
    seedShared("m13-4-seed", "nu xi omicron m13 throw", "a,b");
    // Throwing router → contradiction LLM call inside linkRelated will throw,
    // but linkRelated's own try/catch + service-level try/catch swallow it.
    const router = mkThrowingRouter();
    const svc = new MemoryService(
      memory.memoryRepo,
      rag,
      memory.logRepo,
      memory,
      { router, log },
    );
    const newId = await svc.insertShared({
      category: "preference",
      content: "nu xi omicron m13 throw plus pi",
      tags: "c,d",
      source: "test",
      confidence: 0.9,
      status: "active",
      kind: "persona",
    });
    expect(typeof newId).toBe("string");
    expect(newId.length).toBeGreaterThan(0);
    const written = memory.getShared(newId);
    expect(written).not.toBeNull();
    // No contradiction edges (router threw); relates edge still drawn pre-LLM.
    const contradicts = memory
      .getEdgesFromSrc(newId, "shared")
      .filter((e) => e.kind === "contradicts");
    expect(contradicts.length).toBe(0);
  });

  test("5. insertContext same wiring → relates edge to context neighbour", async () => {
    seedContext("m13-5-seed", "rho sigma tau m13 ctx-link", "a,b");
    const router = mkRouter();
    const svc = new MemoryService(
      memory.memoryRepo,
      rag,
      memory.logRepo,
      memory,
      { router, log },
    );
    const newId = await svc.insertContext({
      title: "ctx-test",
      content: "rho sigma tau m13 ctx-link plus upsilon",
      tags: "c,d",
      confidence: 0.9,
    });
    const edges = memory.getEdgesFromSrc(newId, "context");
    const relates = edges.filter((e) => e.kind === "relates");
    expect(relates.length).toBeGreaterThanOrEqual(1);
    expect(relates.some((e) => e.dst_id === "m13-5-seed")).toBe(true);
    // Tag evolution chain also fires for context layer.
    const evolved = (memory.getContext("m13-5-seed")?.tags ?? "").split(",");
    expect(evolved).toEqual(["a", "b", "c", "d"]);
  });
});
