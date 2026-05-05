/**
 * MEM-5 (PR 22a): confidence-driven status mapping in writeShared /
 * writeContext + registry-level required-confidence validation for
 * `memory_write` (TypeBox rejects when the field is missing).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { Value } from "@sinclair/typebox/value";
import { MemoryDB } from "../src/db";
import { buildRegistry } from "../src/mcp/registry";
import { writeContext, writeShared } from "../src/pipeline/agent-pipeline/post/extractors";
import { RAGPipeline } from "../src/rag";

const TEST_DB = "data/test-memory-confidence.db";

const log = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
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

function cleanup(): void {
  for (const ext of ["", "-shm", "-wal"]) {
    const p = `${TEST_DB}${ext}`;
    if (existsSync(p)) unlinkSync(p);
  }
}

describe("writeShared / writeContext — confidence → status mapping", () => {
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

  test("confidence ≥ 0.8 → status='active' (shared)", async () => {
    const wr = await writeShared(
      memory,
      rag,
      mkRouter(),
      { category: "profile", content: "confirmed fact A", tags: "", confidence: 0.9 },
      log,
    );
    expect(wr.ok).toBe(true);
    expect(wr.status).toBe("active");
    const row = memory.getShared(wr.id!);
    expect(row?.status).toBe("active");
    expect(row?.confidence).toBeCloseTo(0.9, 5);
  });

  test("confidence < 0.8 → status='pending' (shared)", async () => {
    const wr = await writeShared(
      memory,
      rag,
      mkRouter(),
      { category: "profile", content: "guess fact B", tags: "", confidence: 0.5 },
      log,
    );
    expect(wr.ok).toBe(true);
    expect(wr.status).toBe("pending");
    const row = memory.getShared(wr.id!);
    expect(row?.status).toBe("pending");
    expect(row?.confidence).toBeCloseTo(0.5, 5);
  });

  test("confidence ≥ 0.8 → status='active' (context)", async () => {
    const wr = await writeContext(
      memory,
      rag,
      mkRouter(),
      { category: "learning", content: "strong inference C", tags: "", confidence: 0.85 },
      "req-test-1",
      log,
    );
    expect(wr.ok).toBe(true);
    expect(wr.status).toBe("active");
    const row = memory.getContext(wr.id!);
    expect(row?.status).toBe("active");
  });

  test("confidence < 0.8 → status='pending' (context)", async () => {
    const wr = await writeContext(
      memory,
      rag,
      mkRouter(),
      { category: "learning", content: "weak inference D", tags: "", confidence: 0.4 },
      "req-test-2",
      log,
    );
    expect(wr.ok).toBe(true);
    expect(wr.status).toBe("pending");
  });

  test("MEMORY_AUTOACCEPT_CONFIDENCE env override lowers threshold", async () => {
    const prev = process.env.MEMORY_AUTOACCEPT_CONFIDENCE;
    process.env.MEMORY_AUTOACCEPT_CONFIDENCE = "0.6";
    try {
      const wr = await writeShared(
        memory,
        rag,
        mkRouter(),
        { category: "profile", content: "env-override fact E", tags: "", confidence: 0.65 },
        log,
      );
      expect(wr.ok).toBe(true);
      expect(wr.status).toBe("active");
    } finally {
      if (prev === undefined) delete process.env.MEMORY_AUTOACCEPT_CONFIDENCE;
      else process.env.MEMORY_AUTOACCEPT_CONFIDENCE = prev;
    }
  });
});

describe("memory_write registry — confidence is required", () => {
  const registry = buildRegistry();
  const tool = registry.get("memory_write");

  test("registry exposes memory_write with confidence schema", () => {
    expect(tool).toBeDefined();
    // TypeBox schema surface — confidence is a numeric property.
    const props = (tool?.input as any).properties;
    expect(props).toHaveProperty("confidence");
    expect(props.confidence.type).toBe("number");
    expect(props.confidence.minimum).toBe(0);
    expect(props.confidence.maximum).toBe(1);
    const required = (tool?.input as any).required as string[];
    expect(required).toContain("confidence");
  });

  test("missing confidence → TypeBox Value.Check fails", () => {
    const ok = Value.Check(tool?.input as any, {
      layer: "shared",
      content: "no confidence here",
      category: "user",
    });
    expect(ok).toBe(false);
  });

  test("valid confidence 0..1 → TypeBox accepts", () => {
    const ok = Value.Check(tool?.input as any, {
      layer: "shared",
      content: "fact",
      category: "user",
      confidence: 0.9,
    });
    expect(ok).toBe(true);
  });

  test("confidence out of range (>1) → TypeBox rejects", () => {
    const ok = Value.Check(tool?.input as any, {
      layer: "shared",
      content: "fact",
      category: "user",
      confidence: 1.5,
    });
    expect(ok).toBe(false);
  });

  test("confidence as string → TypeBox rejects (legacy HIGH/LOW no longer accepted on registry)", () => {
    const ok = Value.Check(tool?.input as any, {
      layer: "archive",
      content: "fact",
      category: "user",
      confidence: "HIGH",
    });
    expect(ok).toBe(false);
  });
});
