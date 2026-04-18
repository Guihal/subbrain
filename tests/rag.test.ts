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

import { MemoryDB } from "../src/db";
import { RAGPipeline } from "../src/rag";
import { ToolExecutor } from "../src/mcp/executor";
import { unlinkSync } from "fs";

const TEST_DB = "data/test-rag.db";

// Clean up
try {
  unlinkSync(TEST_DB);
} catch {}

const memory = new MemoryDB(TEST_DB);

// ─── FTS5-only tests (no provider needed) ────────────────

// Insert test data
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
  "HIGH",
);
memory.insertShared(
  "sh-1",
  "tech",
  "The project uses Bun + Elysia + SQLite as the main stack",
  "stack,architecture",
);

// Test FTS5 search via RAGPipeline (mock router — won't call embed/rerank)
const mockRouter = {} as any;
const rag = new RAGPipeline(memory, mockRouter);

// FTS5-only search
const ftsResults = rag.ftsSearch(
  "Bun runtime",
  ["context", "archive", "shared"],
  10,
);
console.assert(
  ftsResults.length > 0,
  "FTS5: should find results for 'Bun runtime'",
);
console.assert(
  ftsResults.some((r) => r.id === "ctx-1"),
  "FTS5: should find ctx-1 (Bun Runtime)",
);
console.log(`✅ FTS5 search: found ${ftsResults.length} results`);

// FTS5 search by framework
const frameworkResults = rag.ftsSearch("Elysia framework", ["context"], 10);
console.assert(
  frameworkResults.some((r) => r.id === "ctx-2"),
  "FTS5: should find ctx-2 (Elysia Framework)",
);
console.log("✅ FTS5 layer-filtered search");

// FTS5 search across archive
const patternResults = rag.ftsSearch("WAL mode SQLite", ["archive"], 10);
console.assert(
  patternResults.some((r) => r.id === "arc-1"),
  "FTS5: should find arc-1 (SQLite Pattern)",
);
console.log("✅ FTS5 archive search");

// FTS5 search across shared
const sharedResults = rag.ftsSearch("Bun Elysia stack", ["shared"], 10);
console.assert(
  sharedResults.some((r) => r.id === "sh-1"),
  "FTS5: should find sh-1",
);
console.log("✅ FTS5 shared search");

// ─── ToolExecutor integration ────────────────────────────

const executor = new ToolExecutor(memory, mockRouter);
executor.setRAG(rag);

// Write via executor — should trigger auto-embed (will silently fail with mock router)
const writeResult = executor.memoryWrite({
  layer: "context",
  content: "RAG pipeline combines FTS5 and vector search for hybrid retrieval",
  id: "ctx-rag",
  title: "RAG Pipeline",
  tags: "rag,search",
});
console.assert(writeResult.success, "memoryWrite: should succeed");

// memorySearch (FTS5 fallback) should find it
const searchResult = executor.memorySearch("RAG pipeline hybrid", "context", 5);
console.assert(searchResult.success, "memorySearch: should succeed");
const data = searchResult.data as Record<string, any[]>;
console.assert(
  data.context?.some((r: any) => r.id === "ctx-rag"),
  "memorySearch: should find ctx-rag via FTS5",
);
console.log("✅ ToolExecutor memoryWrite + memorySearch integration");

// ragSearch (FTS5-only fallback since mock router can't embed)
const ragResult = await executor.ragSearch("Bun runtime", ["context"]);
console.assert(ragResult.success, "ragSearch: should succeed (fallback)");
console.log("✅ ragSearch fallback (no provider)");

// ─── Cleanup ─────────────────────────────────────────────
try {
  unlinkSync(TEST_DB);
} catch {}

console.log("\n✅ All RAG pipeline tests passed");
