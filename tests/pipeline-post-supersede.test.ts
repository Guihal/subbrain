/**
 * MEM-6: memory_write supersedes — atomic insert + mark old rows superseded.
 * Validates supersedes ids exist in same layer + not already superseded;
 * caps at 10.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { MemoryDB } from "../src/db";
import { RAGPipeline } from "../src/rag";
import { writeContext } from "../src/pipeline/agent-pipeline/post/extractors";

const TEST_DB = "data/test-post-supersede.db";

const log = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
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

describe("memory_write supersedes (MEM-6)", () => {
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

  test("write with supersedes → old rows get superseded_by = new id", async () => {
    const r1 = await writeContext(
      memory,
      rag,
      { category: "decision", content: "Старый план: vpn через WireGuard", tags: "", confidence: 0.9 },
      "req-old-1",
      log,
    );
    expect(r1.ok).toBe(true);
    const oldId = r1.id!;

    const r2 = await writeContext(
      memory,
      rag,
      {
        category: "decision",
        content: "Новый план: vpn через V2Ray + cloak (заменяет WireGuard)",
        tags: "",
        confidence: 0.95,
        supersedes: [oldId],
      },
      "req-new-1",
      log,
    );
    expect(r2.ok).toBe(true);
    const newId = r2.id!;
    expect(newId).not.toBe(oldId);

    const oldRow = memory.getContext(oldId);
    expect(oldRow!.superseded_by).toBe(newId);
  });

  test("supersedes referencing non-existent id → reject", async () => {
    const r = await writeContext(
      memory,
      rag,
      {
        category: "decision",
        content: "fresh fact",
        tags: "",
        confidence: 0.9,
        supersedes: ["does-not-exist"],
      },
      "req-bad-1",
      log,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not found/);
  });

  test("supersedes referencing already-superseded id → reject", async () => {
    const r1 = await writeContext(
      memory,
      rag,
      { category: "decision", content: "first ride 1", tags: "", confidence: 0.9 },
      "req-1", log,
    );
    const r2 = await writeContext(
      memory,
      rag,
      { category: "decision", content: "second ride 2 (replaces first)", tags: "", confidence: 0.9, supersedes: [r1.id!] },
      "req-2", log,
    );
    expect(r2.ok).toBe(true);
    const r3 = await writeContext(
      memory,
      rag,
      { category: "decision", content: "third ride 3 attempt to re-supersede", tags: "", confidence: 0.9, supersedes: [r1.id!] },
      "req-3", log,
    );
    expect(r3.ok).toBe(false);
    expect(r3.error).toMatch(/already superseded/);
  });

  test("supersedes cap (≤10)", async () => {
    const big = Array.from({ length: 11 }, (_, i) => `id-${i}`);
    const r = await writeContext(
      memory,
      rag,
      { category: "decision", content: "many supersedes", tags: "", confidence: 0.9, supersedes: big },
      "req-cap", log,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/too large/);
  });
});
