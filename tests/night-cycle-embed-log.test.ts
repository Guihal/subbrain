/** M-04.1 night-cycle embed-log + RAG vec unblock for layer="log". §Тесты. */
import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { MemoryDB } from "../src/db";
import { RAGPipeline } from "../src/rag";
import { runEmbedLog } from "../src/pipeline/night-cycle/steps/embed-log";

const TEST_DB = "data/test-mem4.1-embed-log.db";
const ENV_KEYS = ["LOG_EMBED_ENABLED", "LOG_EMBED_CAP", "LOG_EMBED_BATCH"] as const;

function cleanup(): void {
  for (const ext of ["", "-shm", "-wal"]) {
    const p = `${TEST_DB}${ext}`;
    if (existsSync(p)) unlinkSync(p);
  }
}
type EnvSnap = Record<string, string | undefined>;
const snapshotEnv = (): EnvSnap =>
  Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
function restoreEnv(snap: EnvSnap): void {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

// Unit-norm 2048-d vector — two close ones → high cosine.
function unit(a: number, b: number): Float32Array {
  const v = new Float32Array(2048); v[0] = a; v[1] = b;
  let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n);
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}
const V_NEAR = unit(1, 0.05);

function mkRouter(opts: {
  embedImpl?: (input: string[]) => Promise<number[][]> | number[][];
} = {}): never {
  const impl = opts.embedImpl ?? ((input: string[]) => input.map(() => Array.from(V_NEAR)));
  return {
    raw: {
      embed: async (req: { input: string[] }) => {
        const vecs = await impl(req.input);
        return { data: vecs.map((e) => ({ embedding: e })) };
      },
      rerank: async () => ({ results: [] }),
    },
    scheduleRaw: async (_p: string, fn: () => Promise<unknown>) => fn(),
  } as never;
}

function seedLogs(memory: MemoryDB, n: number, prefix = "log row"): void {
  for (let i = 0; i < n; i++) {
    memory.appendLog(`req-${i}`, "sess-A", "agent-A", "user", `${prefix} ${i}`);
  }
}
const countLogVecs = (m: MemoryDB) => m.logRepo.countLogEmbeddings();

describe("M-04.1 night-cycle embed-log step", () => {
  let memory: MemoryDB;
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
  });

  test("no log rows → no-op all-zero result", async () => {
    const rag = new RAGPipeline(memory, mkRouter());
    const r = await runEmbedLog({ memory, rag });
    expect(r).toEqual({ embedded: 0, evicted: 0, errors: 0 });
    expect(countLogVecs(memory)).toBe(0);
    restoreEnv(envSnap);
  });

  test("initial backfill: embeds all unembedded recent rows", async () => {
    seedLogs(memory, 100);
    process.env.LOG_EMBED_BATCH = "30"; // 30,30,30,10
    const rag = new RAGPipeline(memory, mkRouter());
    const r = await runEmbedLog({ memory, rag });
    expect(r.embedded).toBe(100);
    expect(r.evicted).toBe(0);
    expect(r.errors).toBe(0);
    expect(countLogVecs(memory)).toBe(100);
    restoreEnv(envSnap);
  });

  test("incremental: rerun embeds only new rows", async () => {
    seedLogs(memory, 50);
    const rag = new RAGPipeline(memory, mkRouter());
    expect((await runEmbedLog({ memory, rag })).embedded).toBe(50);
    seedLogs(memory, 20, "newer log row");
    const second = await runEmbedLog({ memory, rag });
    expect(second.embedded).toBe(20);
    expect(second.errors).toBe(0);
    expect(countLogVecs(memory)).toBe(70);
    restoreEnv(envSnap);
  });

  test("rolling cap: fill to cap, lower cap → eviction", async () => {
    seedLogs(memory, 15);
    process.env.LOG_EMBED_CAP = "10";
    const rag = new RAGPipeline(memory, mkRouter());
    const r = await runEmbedLog({ memory, rag });
    expect(r).toEqual({ embedded: 10, evicted: 0, errors: 0 });
    expect(countLogVecs(memory)).toBe(10);
    process.env.LOG_EMBED_CAP = "5";
    const r2 = await runEmbedLog({ memory, rag });
    expect(r2).toEqual({ embedded: 0, evicted: 5, errors: 0 });
    expect(countLogVecs(memory)).toBe(5);
    restoreEnv(envSnap);
  });

  test("embed failure → errors counted, step does not throw", async () => {
    seedLogs(memory, 30);
    process.env.LOG_EMBED_BATCH = "10"; // 3 batches
    let calls = 0;
    const rag = new RAGPipeline(
      memory,
      mkRouter({
        embedImpl: (input) => {
          calls++;
          if (calls === 2) throw new Error("simulated NVIDIA 503");
          return input.map(() => Array.from(V_NEAR));
        },
      }),
    );
    const r = await runEmbedLog({ memory, rag });
    expect(r.errors).toBe(1);
    expect(r.embedded).toBe(20); // 2 successful × 10
    expect(countLogVecs(memory)).toBe(20);
    restoreEnv(envSnap);
  });

  test("LOG_EMBED_ENABLED=false → step no-op", async () => {
    seedLogs(memory, 10);
    process.env.LOG_EMBED_ENABLED = "false";
    const rag = new RAGPipeline(memory, mkRouter());
    const r = await runEmbedLog({ memory, rag });
    expect(r).toEqual({ embedded: 0, evicted: 0, errors: 0 });
    expect(countLogVecs(memory)).toBe(0);
    restoreEnv(envSnap);
  });

  test("RAG layers:[\"log\"] vec branch contributes hits (FTS-empty case)", async () => {
    // Content shares no tokens with query → FTS empty; vec branch carries.
    seedLogs(memory, 5, "zzz xyzzy frobnicate");
    const rag = new RAGPipeline(memory, mkRouter());
    await runEmbedLog({ memory, rag });
    expect(countLogVecs(memory)).toBe(5);
    const out = await rag.search({
      query: "completely-disjoint-query-term",
      layers: ["log"],
      rerankTopN: 5,
      skipRerank: true,
    });
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((r) => r.layer === "log")).toBe(true);
    expect(out[0].title).toBe("user"); // hydrated role
    expect(out[0].snippet).toContain("frobnicate"); // hydrated content
    restoreEnv(envSnap);
  });

  test("default RAG layers excludes log even with embeddings (privacy)", async () => {
    seedLogs(memory, 5, "default-canary watermelon split sundae");
    const rag = new RAGPipeline(memory, mkRouter());
    await runEmbedLog({ memory, rag });
    expect(countLogVecs(memory)).toBe(5);
    const out = await rag.search({
      query: "watermelon",
      rerankTopN: 5,
      skipRerank: true,
    });
    // Default = ["context","archive","shared"] — log MUST NOT surface.
    expect(out.every((r) => r.layer !== "log")).toBe(true);
    restoreEnv(envSnap);
  });

  test("LOG_EMBED_CAP=0 → drop window entirely", async () => {
    seedLogs(memory, 5);
    process.env.LOG_EMBED_CAP = "5";
    const rag = new RAGPipeline(memory, mkRouter());
    await runEmbedLog({ memory, rag });
    expect(countLogVecs(memory)).toBe(5);
    process.env.LOG_EMBED_CAP = "0";
    const r = await runEmbedLog({ memory, rag });
    expect(r.embedded).toBe(0);
    expect(r.evicted).toBe(5);
    expect(countLogVecs(memory)).toBe(0);
    restoreEnv(envSnap);
  });
});
