/**
 * RAG pipeline integration test.
 *
 * Tests:
 * - Auto-embed on memory_write via ToolExecutor
 * - FTS5-only search (no RPM)
 * - RAG hybrid search (ragSearch)
 * - rag_search via REST transport
 *
 * NOTE: Vector + rerank tests require a live NVIDIA API key.
 * FTS5-only tests work offline.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { ToolExecutor } from "@subbrain/agent/mcp/executor";
import { RAGPipeline } from "@subbrain/agent/rag";
import { MemoryDB } from "@subbrain/core/db";

const TEST_DB = "data/test-rag.db";

function cleanup() {
  for (const ext of ["", "-shm", "-wal"]) {
    const p = `${TEST_DB}${ext}`;
    if (existsSync(p)) unlinkSync(p);
  }
}

describe("RAG pipeline (FTS5 + ToolExecutor)", () => {
  let memory: MemoryDB;
  let rag: RAGPipeline;
  let executor: ToolExecutor;
  const mockRouter = {} as any;

  beforeAll(() => {
    cleanup();
    memory = new MemoryDB(TEST_DB);

    memory.insertContext(
      "ctx-1",
      "Bun Runtime",
      "Bun is a fast JavaScript runtime with built-in bundler and package manager",
      "runtime,javascript",
    );
    memory.insertContext(
      "ctx-2",
      "Elysia Framework",
      "Elysia is an ergonomic web framework built for Bun with end-to-end type safety",
      "framework,typescript",
    );
    memory.insertArchive(
      "arc-1",
      "SQLite Pattern",
      "Use WAL mode for concurrent reads. FTS5 for full-text search. sqlite-vec for embeddings.",
      "patterns,database",
      [],
      0.9, // M-12 (mig 15): REAL confidence
    );
    memory.insertShared(
      "sh-1",
      "tech",
      "The project uses Bun + Elysia + SQLite as the main stack",
      "stack,architecture",
    );

    rag = new RAGPipeline(memory, mockRouter);
    executor = new ToolExecutor(memory, mockRouter);
    executor.setRAG(rag);
  });

  afterAll(() => {
    cleanup();
  });

  test("FTS5: finds results for 'Bun runtime' across layers", () => {
    const results = rag.ftsSearch("Bun runtime", ["context", "archive", "shared"], 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.id === "ctx-1")).toBe(true);
  });

  test("FTS5: layer-filtered search finds Elysia in context only", () => {
    const results = rag.ftsSearch("Elysia framework", ["context"], 10);
    expect(results.some((r) => r.id === "ctx-2")).toBe(true);
  });

  test("FTS5: archive-only search finds SQLite Pattern", () => {
    const results = rag.ftsSearch("WAL mode SQLite", ["archive"], 10);
    expect(results.some((r) => r.id === "arc-1")).toBe(true);
  });

  test("FTS5: shared-only search finds stack entry", () => {
    const results = rag.ftsSearch("Bun Elysia stack", ["shared"], 10);
    expect(results.some((r) => r.id === "sh-1")).toBe(true);
  });

  test("ToolExecutor: memoryWrite + memorySearch via FTS5 fallback", async () => {
    // PR-A: writeContextCase is async when rag present (dedup) → must await.
    const writeResult = await executor.memoryWrite({
      layer: "context",
      content: "RAG pipeline combines FTS5 and vector search for hybrid retrieval",
      id: "ctx-rag",
      title: "RAG Pipeline",
      tags: "rag,search",
    });
    expect(writeResult.success).toBe(true);

    const searchResult = executor.memorySearch("RAG pipeline hybrid", "context", 5);
    expect(searchResult.success).toBe(true);
    const data = searchResult.data as Record<string, any[]>;
    expect(data.context?.some((r: any) => r.id === "ctx-rag")).toBe(true);
  });

  test("ragSearch: FTS5 fallback succeeds without provider", async () => {
    const result = await executor.ragSearch("Bun runtime", ["context"]);
    expect(result.success).toBe(true);
  });
});
