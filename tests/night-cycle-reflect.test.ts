/** M-06 reflect step — CoALA episodic→semantic. See plan §Тесты. */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { MemoryDB } from "../src/db";
import { RAGPipeline } from "../src/rag";
import { MemoryService } from "../src/services/memory";
import { runReflect } from "../src/pipeline/night-cycle/steps/reflect";

const TEST_DB = "data/test-mem6-reflect.db";
const ENV_KEYS = [
  "REFLECT_ENABLED",
  "REFLECT_MIN_ACCESS",
  "REFLECT_MIN_GROUP",
  "REFLECT_MAX_GROUPS",
] as const;

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

function makeRouter(opts: {
  reply: string | (() => string);
  fail?: boolean;
}): any {
  const router: any = {
    raw: {
      embed: async (req: { input: string[] }) => ({
        data: req.input.map((t) => ({ embedding: Array.from(fakeEmbed(t)) })),
      }),
      rerank: async () => ({ results: [] }),
    },
    scheduleRaw: async (_p: string, fn: () => Promise<any>) => fn(),
    chatCalls: 0,
    lastMessages: null as any,
    chat: async (_model: string, params: any) => {
      router.chatCalls++;
      router.lastMessages = params?.messages;
      if (opts.fail) throw new Error("simulated llm failure");
      const reply = typeof opts.reply === "function" ? opts.reply() : opts.reply;
      return { choices: [{ message: { content: reply } }] };
    },
  };
  return router;
}

// Backdate created_at + set access_count so row qualifies for reflect SQL.
function seedContext(
  memory: MemoryDB,
  _rag: RAGPipeline,
  id: string,
  category: string,
  content: string,
  access: number = 5,
): void {
  memory.insertContext(id, category, content, "");
  const past = Math.floor(Date.now() / 1000) - 30 * 60 * 60;
  memory.db
    .query("UPDATE layer2_context SET created_at = ?, access_count = ? WHERE id = ?")
    .run(past, access, id);
  memory.upsertEmbedding(id, "context", fakeEmbed(content));
}

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

describe("M-06 reflect (CoALA episodic→semantic)", () => {
  let memory: MemoryDB;
  let rag: RAGPipeline;
  let envSnap: Record<string, string | undefined>;

  beforeAll(() => {
    cleanup();
    envSnap = snapshotEnv();
  });

  afterAll(() => {
    restoreEnv(envSnap);
    cleanup();
  });

  beforeEach(() => {
    if (memory) memory.close();
    cleanup();
    memory = new MemoryDB(TEST_DB);
    rag = new RAGPipeline(memory, makeRouter({ reply: "" }));
    // Reset env to defaults for predictable behaviour.
    delete process.env.REFLECT_ENABLED;
    delete process.env.REFLECT_MIN_ACCESS;
    delete process.env.REFLECT_MIN_GROUP;
    delete process.env.REFLECT_MAX_GROUPS;
  });

  test("empty context → no-op", async () => {
    const router = makeRouter({ reply: "should-not-be-called" });
    rag = new RAGPipeline(memory, router);
    const svc = new MemoryService(memory.memoryRepo, rag, memory.logRepo);
    const r = await runReflect({ memory, memoryService: svc, rag, router });
    expect(r).toEqual({
      groups_examined: 0,
      facts_promoted: 0,
      edges_created: 0,
      llm_failures: 0,
    });
    expect(router.chatCalls).toBe(0);
  });

  test("below access threshold → group skipped", async () => {
    const router = makeRouter({ reply: "should-not-fire" });
    rag = new RAGPipeline(memory, router);
    for (let i = 0; i < 4; i++) {
      seedContext(memory, rag, `low-${i}`, "project", `entry ${i} alpha`, 2);
    }
    const svc = new MemoryService(memory.memoryRepo, rag, memory.logRepo);
    const r = await runReflect({ memory, memoryService: svc, rag, router });
    expect(r.groups_examined).toBe(0);
    expect(router.chatCalls).toBe(0);
  });

  test("below group threshold → skipped", async () => {
    const router = makeRouter({ reply: "should-not-fire" });
    rag = new RAGPipeline(memory, router);
    for (let i = 0; i < 2; i++) {
      seedContext(memory, rag, `g-${i}`, "project", `entry ${i} beta`, 5);
    }
    const svc = new MemoryService(memory.memoryRepo, rag, memory.logRepo);
    const r = await runReflect({ memory, memoryService: svc, rag, router });
    expect(r.groups_examined).toBe(0);
    expect(router.chatCalls).toBe(0);
  });

  test("successful promote → shared row + 'derives' edges + weight=1.0", async () => {
    const router = makeRouter({ reply: "Project Subbrain uses Bun runtime for backend." });
    rag = new RAGPipeline(memory, router);
    const ids = ["src-1", "src-2", "src-3"];
    for (const id of ids) {
      seedContext(
        memory,
        rag,
        id,
        "project",
        `Project Subbrain uses Bun runtime — ${id}`,
        5,
      );
    }
    const svc = new MemoryService(memory.memoryRepo, rag, memory.logRepo);
    const r = await runReflect({ memory, memoryService: svc, rag, router });
    expect(r.groups_examined).toBe(1);
    expect(r.facts_promoted).toBe(1);
    expect(r.edges_created).toBe(3);
    expect(r.llm_failures).toBe(0);
    expect(router.chatCalls).toBe(1);

    // Verify the new shared row.
    const sharedRows = memory.db
      .query<{ id: string; category: string; content: string; kind: string; source: string | null }, []>(
        "SELECT id, category, content, kind, source FROM shared_memory WHERE source = 'reflect'",
      )
      .all();
    expect(sharedRows.length).toBe(1);
    expect(sharedRows[0].kind).toBe("semantic");
    expect(sharedRows[0].category).toBe("project");
    expect(sharedRows[0].content).toContain("Bun");
    const newId = sharedRows[0].id;

    // Verify 'derives' edges from each source context.
    for (const srcId of ids) {
      const out = memory.getEdgesFromSrc(srcId, "context", ["derives"]);
      expect(out.length).toBe(1);
      expect(out[0].dst_id).toBe(newId);
      expect(out[0].dst_layer).toBe("shared");
      expect(out[0].kind).toBe("derives");
      expect(out[0].weight).toBeCloseTo(1.0, 5);
    }
  });

  test("LLM returns 'NULL' literal → no insert, no edges", async () => {
    const router = makeRouter({ reply: "NULL" });
    rag = new RAGPipeline(memory, router);
    for (let i = 0; i < 3; i++) {
      seedContext(memory, rag, `null-${i}`, "decision", `decision pattern ${i}`, 5);
    }
    const svc = new MemoryService(memory.memoryRepo, rag, memory.logRepo);
    const r = await runReflect({ memory, memoryService: svc, rag, router });
    expect(r.groups_examined).toBe(1);
    expect(r.facts_promoted).toBe(0);
    expect(r.edges_created).toBe(0);
    const sharedCount = memory.db
      .query<{ c: number }, []>("SELECT count(*) AS c FROM shared_memory WHERE source = 'reflect'")
      .get()!.c;
    expect(sharedCount).toBe(0);
  });

  test("skip-guard: existing same-category shared cosine ≥ 0.85 → skip", async () => {
    const candidate = "Project uses Bun runtime for backend systems";
    // Seed an existing shared row with very similar content + same category.
    const existingId = "existing-shared-1";
    memory.insertShared(existingId, "project", candidate, "");
    memory.upsertEmbedding(existingId, "shared", fakeEmbed(candidate));

    const router = makeRouter({ reply: candidate });
    rag = new RAGPipeline(memory, router);
    for (let i = 0; i < 3; i++) {
      seedContext(memory, rag, `dup-${i}`, "project", `${candidate} src${i}`, 5);
    }
    const svc = new MemoryService(memory.memoryRepo, rag, memory.logRepo);
    const r = await runReflect({ memory, memoryService: svc, rag, router });
    expect(r.groups_examined).toBe(1);
    expect(r.facts_promoted).toBe(0);
    expect(r.edges_created).toBe(0);
    // Existing row stays the only one with source != 'reflect'.
    const reflectRows = memory.db
      .query<{ c: number }, []>("SELECT count(*) AS c FROM shared_memory WHERE source = 'reflect'")
      .get()!.c;
    expect(reflectRows).toBe(0);
  });

  test("LLM failure → llm_failures counted, step not thrown", async () => {
    const router = makeRouter({ reply: "", fail: true });
    rag = new RAGPipeline(memory, router);
    for (let i = 0; i < 3; i++) {
      seedContext(memory, rag, `fail-${i}`, "bug", `bug entry ${i} repro steps`, 5);
    }
    const svc = new MemoryService(memory.memoryRepo, rag, memory.logRepo);
    const r = await runReflect({ memory, memoryService: svc, rag, router });
    expect(r.groups_examined).toBe(1);
    expect(r.llm_failures).toBe(1);
    expect(r.facts_promoted).toBe(0);
    expect(r.edges_created).toBe(0);
  });

  test("REFLECT_ENABLED=false → no SQL, no LLM, zeros", async () => {
    process.env.REFLECT_ENABLED = "false";
    const router = makeRouter({ reply: "should-not-fire" });
    rag = new RAGPipeline(memory, router);
    for (let i = 0; i < 3; i++) {
      seedContext(memory, rag, `off-${i}`, "project", `entry ${i}`, 5);
    }
    const svc = new MemoryService(memory.memoryRepo, rag, memory.logRepo);
    const r = await runReflect({ memory, memoryService: svc, rag, router });
    expect(r).toEqual({
      groups_examined: 0,
      facts_promoted: 0,
      edges_created: 0,
      llm_failures: 0,
    });
    expect(router.chatCalls).toBe(0);
  });

  test("non-whitelist title (e.g. 'preference') → skipped from group selection", async () => {
    // Mix: 3 rows in 'preference' (NOT in context whitelist) + 3 in 'learning'
    // (whitelisted). Only 'learning' should reflect.
    const router = makeRouter({ reply: "Consolidated learning fact." });
    rag = new RAGPipeline(memory, router);
    for (let i = 0; i < 3; i++) {
      seedContext(memory, rag, `pref-${i}`, "preference", `pref ${i}`, 5);
      seedContext(memory, rag, `learn-${i}`, "learning", `learn ${i} insight`, 5);
    }
    const svc = new MemoryService(memory.memoryRepo, rag, memory.logRepo);
    const r = await runReflect({ memory, memoryService: svc, rag, router });
    expect(r.groups_examined).toBe(1);
    expect(r.facts_promoted).toBe(1);
    expect(router.chatCalls).toBe(1);
    const sharedRows = memory.db
      .query<{ category: string }, []>(
        "SELECT category FROM shared_memory WHERE source = 'reflect'",
      )
      .all();
    expect(sharedRows.length).toBe(1);
    expect(sharedRows[0].category).toBe("learning");
  });
});
