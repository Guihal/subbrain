/**
 * PR 24 — writeShared must embed + upsert vec_embedding atomically.
 * Regression: before PR 24, writeShared did not embed, so vec search
 * could not find shared rows and rag-hydration for shared was broken.
 *
 * M-01 (MEM-2) — extended for the second wave of writers: MemoryService
 * (admin REST), MemoryTools (MCP shared layer), and the context-compressor
 * shim ChatService passes in. Each path must produce the same atomic
 * insert+vec invariant: 0 shared_memory rows without a matching
 * vec_embeddings row when layer='shared'.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { MemoryDB } from "@subbrain/core/db";
import { MemoryTools } from "../src/mcp/tools/memory";
import { writeShared } from "../src/pipeline/agent-pipeline/post/extractors";
import { type CompressorMemory, compressContext } from "../src/pipeline/context-compressor";
import type { Message } from "../src/providers/types";
import { RAGPipeline } from "../src/rag";
import { MemoryService } from "../src/services/memory";

const TEST_DB = "data/test-shared-embed.db";

const log = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as any;

// Deterministic "embedding": non-zero bag-of-chars hash, 2048 dims.
function fakeEmbed(text: string): Float32Array {
  const vec = new Float32Array(2048);
  for (let i = 0; i < text.length; i++) {
    vec[text.charCodeAt(i) % 2048] += 1;
  }
  // ensure non-empty + not all-zero even for pathological inputs
  vec[0] += 0.01;
  return vec;
}

function mkRouter() {
  return {
    chat: async () => {
      throw new Error("router.chat not used in this test");
    },
    raw: {
      embed: async (req: { input: string[] }) => ({
        data: req.input.map((t) => ({ embedding: Array.from(fakeEmbed(t)) })),
      }),
      rerank: async () => ({ results: [] }),
    },
    scheduleRaw: async (_p: string, fn: () => Promise<any>) => fn(),
  } as any;
}

describe("writeShared — embed + transactional persistence (PR 24)", () => {
  let memory: MemoryDB;
  let rag: RAGPipeline;

  beforeAll(() => {
    try {
      unlinkSync(TEST_DB);
    } catch {}
    memory = new MemoryDB(TEST_DB);
    rag = new RAGPipeline(memory, mkRouter());
  });

  test("inserts shared row AND upserts vec_embedding with layer=shared", async () => {
    const wr = await writeShared(
      memory,
      rag,
      mkRouter(),
      { category: "skill", content: "fact X: SNMP uses UDP 161", tags: "snmp", confidence: 0.95 },
      log,
    );
    expect(wr.ok).toBe(true);
    expect(typeof wr.id).toBe("string");

    // shared_memory row present
    const row = memory.getShared(wr.id!);
    expect(row).not.toBeNull();
    expect(row?.content).toContain("fact X");
    expect(row?.status).toBe("active");

    // vec_embedding row present for layer=shared
    const vecRow = memory.db
      .query("SELECT id, layer FROM vec_embeddings WHERE id = ?")
      .get(wr.id!) as { id: string; layer: string } | null;
    expect(vecRow).not.toBeNull();
    expect(vecRow?.layer).toBe("shared");
  });

  test("retrieveShared via RAG vec path returns populated snippet", async () => {
    // seed an extra shared row
    const wr = await writeShared(
      memory,
      rag,
      mkRouter(),
      {
        category: "skill",
        content: "fact X extra content about SNMP discovery",
        tags: "",
        confidence: 0.9,
      },
      log,
    );
    expect(wr.ok).toBe(true);

    const results = await rag.search({
      query: "fact X SNMP discovery",
      layers: ["shared"],
      skipRerank: true,
    });
    expect(results.length).toBeGreaterThan(0);

    const hit = results.find((r) => r.id === wr.id);
    expect(hit).toBeDefined();
    // snippet populated (not empty, not just id); FTS path may wrap
    // matched tokens in <b>...</b>, vec-only path returns raw content.
    expect(hit?.snippet.length).toBeGreaterThan(0);
    const plainSnippet = hit?.snippet.replace(/<\/?b>/g, "");
    expect(plainSnippet).toContain("fact X");
    // title is category (mapped from SharedRow)
    expect(hit?.title).toBe("skill");
  });

  test("embed timeout → no DB rows written (atomic)", async () => {
    // H-1: mock now honors signal — embed waits and rejects on signal.aborted,
    // mirroring real upstream behavior (fetchJson propagates signal).
    const hangingRouter = {
      raw: {
        embed: (params: { signal?: AbortSignal }) =>
          new Promise((_, rej) => {
            const signal = params.signal;
            if (!signal) return; // never resolves without signal — old behavior
            if (signal.aborted) {
              rej(signal.reason ?? new Error("aborted"));
              return;
            }
            signal.addEventListener("abort", () => rej(signal.reason ?? new Error("aborted")), {
              once: true,
            });
          }),
        rerank: async () => ({ results: [] }),
      },
      scheduleRaw: async (_p: string, fn: () => Promise<any>) => fn(),
    } as any;
    const ragHang = new RAGPipeline(memory, hangingRouter);

    const before = memory.countShared();
    const wr = await writeShared(
      memory,
      ragHang,
      hangingRouter,
      { category: "skill", content: "should never persist", tags: "", confidence: 0.9 },
      log,
    );
    expect(wr.ok).toBe(false);
    // AbortSignal.timeout fires DOMException("The operation timed out.",
    // "TimeoutError") — match the timeout-flavored error.
    expect(String(wr.error)).toMatch(/timed out|timeout|aborted/i);
    expect(memory.countShared()).toBe(before);
  }, 10_000);
});

// ─── M-01 (MEM-2) — second-wave writers ───────────────────────────────────
//
// Verifies that the writers explicitly listed in the M-01 plan §Файлы all
// embed+insert atomically, mirroring the post/extractors path.

const MEM2_DB = "data/test-mem2-writers.db";

function countOrphans(memory: MemoryDB): number {
  const row = memory.db
    .query(
      "SELECT COUNT(*) AS c FROM shared_memory WHERE id NOT IN (SELECT id FROM vec_embeddings WHERE layer='shared')",
    )
    .get() as { c: number };
  return row.c;
}

describe("M-01 / MEM-2 — shared_memory writers all embed atomically", () => {
  let memory: MemoryDB;
  let rag: RAGPipeline;

  beforeAll(() => {
    try {
      unlinkSync(MEM2_DB);
    } catch {}
    memory = new MemoryDB(MEM2_DB);
    rag = new RAGPipeline(memory, mkRouter());
  });

  test("MemoryService.insertShared writes shared row + vec atomically", async () => {
    const svc = new MemoryService(memory.memoryRepo, rag, memory.logRepo);
    const id = await svc.insertShared({
      category: "user",
      content: "Service-path fact about the user.",
      tags: "user",
      source: "test-service",
    });
    expect(typeof id).toBe("string");

    const row = memory.getShared(id);
    expect(row).not.toBeNull();
    expect(row?.content).toBe("Service-path fact about the user.");

    const vec = memory.db.query("SELECT id, layer FROM vec_embeddings WHERE id = ?").get(id) as {
      id: string;
      layer: string;
    } | null;
    expect(vec).not.toBeNull();
    expect(vec?.layer).toBe("shared");
  });

  test("MemoryService rolls back when embed throws (no orphan row)", async () => {
    const failingRouter = {
      raw: {
        embed: async () => {
          throw new Error("simulated_embed_fail");
        },
        rerank: async () => ({ results: [] }),
      },
      scheduleRaw: async (_p: string, fn: () => Promise<unknown>) => fn(),
    } as unknown as Parameters<typeof RAGPipeline>[1];
    const ragFail = new RAGPipeline(memory, failingRouter);
    const svc = new MemoryService(memory.memoryRepo, ragFail, memory.logRepo);

    const before = memory.countShared();
    let threw = false;
    try {
      await svc.insertShared({
        category: "user",
        content: "Should never persist — embed will fail.",
        tags: "",
        source: "test-service",
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(memory.countShared()).toBe(before);
  });

  test("MemoryTools.write layer=shared persists row + vec via embed-first path", async () => {
    const tools = new MemoryTools(memory, () => rag);
    const result = await tools.write({
      layer: "shared",
      content: "MCP-path fact about TypeScript.",
      category: "tech",
      tags: "ts",
      confidence: 0.95,
    });
    expect(result.success).toBe(true);
    const insertedId = (result.data as { id: string }).id;

    const row = memory.getShared(insertedId);
    expect(row).not.toBeNull();
    expect(row?.content).toBe("MCP-path fact about TypeScript.");

    const vec = memory.db
      .query("SELECT id, layer FROM vec_embeddings WHERE id = ?")
      .get(insertedId) as { id: string; layer: string } | null;
    expect(vec).not.toBeNull();
    expect(vec?.layer).toBe("shared");
  });

  test("MemoryTools.write embed-fail returns error and writes no row", async () => {
    const failingRouter = {
      raw: {
        embed: async () => {
          throw new Error("simulated_embed_fail");
        },
        rerank: async () => ({ results: [] }),
      },
      scheduleRaw: async (_p: string, fn: () => Promise<unknown>) => fn(),
    } as unknown as Parameters<typeof RAGPipeline>[1];
    const ragFail = new RAGPipeline(memory, failingRouter);
    const tools = new MemoryTools(memory, () => ragFail);

    const before = memory.countShared();
    const result = await tools.write({
      layer: "shared",
      content: "MCP-path embed fail row.",
      category: "tech",
      confidence: 0.9,
    });
    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/embed_fail|simulated_embed_fail/i);
    expect(memory.countShared()).toBe(before);
  });

  test("compressor shim wrapping MemoryService persists facts with vec", async () => {
    const svc = new MemoryService(memory.memoryRepo, rag, memory.logRepo);
    const shim: CompressorMemory = {
      insertShared: (_id, category, content, tags, source, opts) =>
        svc.insertShared({
          category,
          content,
          tags: tags ?? "",
          source,
          confidence: opts?.confidence,
          status: opts?.status,
        }),
    };

    // Fake compressor router: returns a JSON summary with two facts so
    // compressContext goes through its persist branch. Build messages large
    // enough to trigger SOFT_LIMIT (80k chars).
    // estimateTokens ≈ JSON.stringify(messages).length / 4. Need >80k tokens,
    // so JSON length must exceed 320k chars. 12 messages × 30k filler each.
    const filler = "x".repeat(30_000);
    const messages: Message[] = [
      { role: "system", content: "system head" },
      { role: "user", content: "first task" },
      ...Array.from({ length: 12 }, (_, i) => ({
        role: "assistant" as const,
        content: `${filler} step-${i}`,
      })),
      { role: "user", content: "tail user" },
    ];
    const compressorRouter = {
      chat: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: "compressed summary stub",
                facts: [
                  { category: "finding", content: "Compressor-path fact A." },
                  { category: "decision", content: "Compressor-path fact B." },
                ],
              }),
            },
          },
        ],
      }),
    } as unknown as Parameters<typeof compressContext>[1];

    const before = memory.countShared();
    const compressed = await compressContext(messages, compressorRouter, shim);
    expect(compressed).toBe(true);
    expect(memory.countShared()).toBeGreaterThanOrEqual(before + 2);

    // Both compressor facts must be embedded too (no orphans).
    expect(countOrphans(memory)).toBe(0);
  });

  test("invariant: zero shared_memory rows without vec_embeddings(layer='shared')", () => {
    expect(countOrphans(memory)).toBe(0);
  });
});
