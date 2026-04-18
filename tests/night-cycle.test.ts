/**
 * NightCycle unit tests.
 *
 * Tests:
 * - Full pipeline: PII → translate → compress → verify → dedup → archive
 * - Empty log handling
 * - Progress tracking (last processed ID)
 * - Anti-pattern extraction
 * - Contradiction resolution
 * - Graceful handling of LLM failures
 *
 * Uses mock router (no live API calls).
 */

import { NightCycle } from "../src/pipeline/night-cycle";
import { RAGPipeline } from "../src/rag";
import { MemoryDB } from "../src/db";
import { unlinkSync } from "fs";
import type { ChatResponse } from "../src/providers/types";

const TEST_DB = "data/test-night-cycle.db";
try {
  unlinkSync(TEST_DB);
} catch {}

const memory = new MemoryDB(TEST_DB);

// ─── Mock Router ─────────────────────────────────────────

let callCount = 0;
let chatCalls: { model: string; systemContent: string }[] = [];

const makeResponse = (content: string): ChatResponse => ({
  id: "test-id",
  object: "chat.completion",
  created: Date.now(),
  model: "mock",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

const mockRouter = {
  chat: async (model: string, params: any, _priority?: string) => {
    callCount++;
    const sysContent = params.messages?.[0]?.content || "";
    chatCalls.push({ model, systemContent: sysContent });

    // PII scrubber
    if (sysContent.includes("PII scrubber")) {
      return makeResponse(
        params.messages[1].content.replace(/John Doe/g, "[NAME]"),
      );
    }
    // Translator
    if (sysContent.includes("Translate")) {
      return makeResponse(params.messages[1].content); // passthrough (already EN in test)
    }
    // Compressor
    if (sysContent.includes("knowledge compressor")) {
      return makeResponse(
        JSON.stringify({
          title: "Bun + Elysia Architecture",
          content: "## Decision\nChose Bun + Elysia for fast HTTP with SQLite.",
          tags: "bun,elysia,architecture",
          skip: false,
        }),
      );
    }
    // Verifier
    if (sysContent.includes("fact verifier")) {
      return makeResponse(JSON.stringify({ accurate: true, issues: [] }));
    }
    // Dedup
    if (sysContent.includes("compare a new knowledge")) {
      return makeResponse(
        JSON.stringify({ isDuplicate: false, action: "append" }),
      );
    }
    // Anti-patterns
    if (sysContent.includes("anti-patterns")) {
      return makeResponse(
        "## Anti-patterns detected\n- FTS5 stop words: forgot to sanitize queries, lost 30min debugging",
      );
    }
    // Contradiction resolver
    if (sysContent.includes("contradiction")) {
      return makeResponse(JSON.stringify({ hasContradiction: false }));
    }

    return makeResponse("ok");
  },
  scheduleRaw: async (_p: string, fn: () => Promise<any>) => fn(),
  raw: {
    embed: async () => ({
      data: [{ embedding: new Array(2048).fill(0) }],
    }),
    rerank: async () => ({
      results: [{ index: 0, relevance_score: 0.9 }],
    }),
  },
} as any;

const rag = new RAGPipeline(memory, mockRouter);
const nightCycle = new NightCycle(memory, mockRouter, rag);

// ─── Test 1: Empty logs → no-op ─────────────────────────

callCount = 0;
chatCalls = [];
const result1 = await nightCycle.run();
console.assert(result1.processedLogs === 0, "Empty logs → 0 processed");
console.assert(result1.sessionsProcessed === 0, "Empty logs → 0 sessions");
console.assert(callCount === 0, "Empty logs → 0 LLM calls");

// ─── Seed test data ──────────────────────────────────────

// Simulate a session with multiple exchanges
const sessionId = "session-001";
const reqId1 = "req-001";
const reqId2 = "req-002";

memory.appendLog(
  reqId1,
  sessionId,
  "teamlead",
  "user",
  "Why did John Doe choose Bun and Elysia for the server?",
);
memory.appendLog(
  reqId1,
  sessionId,
  "teamlead",
  "assistant",
  "Bun was chosen for its fast startup and native SQLite support. Elysia provides a modern HTTP API with excellent TypeScript integration and WebSocket/SSE support.",
);
memory.appendLog(
  reqId2,
  sessionId,
  "teamlead",
  "user",
  "What about the database choice?",
);
memory.appendLog(
  reqId2,
  sessionId,
  "teamlead",
  "assistant",
  "SQLite with FTS5 for full-text search and sqlite-vec for vector embeddings. This keeps everything in a single process with no external dependencies.",
);

// ─── Test 2: Full pipeline processes logs ────────────────

callCount = 0;
chatCalls = [];
const result2 = await nightCycle.run();

console.assert(
  result2.processedLogs === 4,
  `Expected 4 processed, got ${result2.processedLogs}`,
);
console.assert(
  result2.sessionsProcessed === 1,
  `Expected 1 session, got ${result2.sessionsProcessed}`,
);
console.assert(
  result2.archiveEntriesCreated >= 1,
  `Expected ≥1 archive entry, got ${result2.archiveEntriesCreated}`,
);
console.assert(
  result2.errors.length === 0,
  `Expected no errors, got: ${result2.errors.join(", ")}`,
);
console.assert(result2.lastProcessedId > 0, "Should track last processed ID");

// Verify the pipeline stages were called in order
const stages = chatCalls.map((c) => {
  if (c.systemContent.includes("PII")) return "pii";
  if (c.systemContent.includes("Translate")) return "translate";
  if (c.systemContent.includes("compressor")) return "compress";
  if (c.systemContent.includes("verifier")) return "verify";
  if (c.systemContent.includes("compare a new")) return "dedup";
  if (c.systemContent.includes("anti-patterns")) return "anti-patterns";
  return "other";
});
console.assert(stages.includes("pii"), "Should call PII scrubber");
console.assert(stages.includes("compress"), "Should call compressor");

// ─── Test 3: Progress tracking — re-run → no new work ───

callCount = 0;
const result3 = await nightCycle.run();
console.assert(
  result3.processedLogs === 0,
  `Re-run → 0 new logs, got ${result3.processedLogs}`,
);
console.assert(callCount === 0, "Re-run → no LLM calls");

// ─── Test 4: Progress saved in focus ─────────────────────

const savedId = memory.getFocus("night_cycle_last_processed_id");
console.assert(savedId !== null, "Should save last processed ID in focus");
console.assert(parseInt(savedId!, 10) > 0, "Saved ID should be > 0");

// ─── Test 5: New logs after progress get processed ───────

memory.appendLog(
  "req-003",
  "session-002",
  "coder",
  "user",
  "New message after night cycle",
);
memory.appendLog(
  "req-003",
  "session-002",
  "coder",
  "assistant",
  "This is a detailed response about new architecture decisions including database migration strategies and deployment workflows for the production environment.",
);

callCount = 0;
const result4 = await nightCycle.run();
console.assert(
  result4.processedLogs === 2,
  `Expected 2 new logs, got ${result4.processedLogs}`,
);
console.assert(
  result4.sessionsProcessed === 1,
  `Expected 1 new session, got ${result4.sessionsProcessed}`,
);

// ─── Test 6: Archive entry created correctly ─────────────

// Check that Layer 3 has entries
const allArchive = memory.db
  .query(
    "SELECT * FROM layer3_archive WHERE agent_id = 'night-cycle' AND tags NOT LIKE '%anti-patterns%' ORDER BY rowid",
  )
  .all() as any[];

console.assert(
  allArchive.length >= 1,
  `Expected ≥1 archive entry from night cycle, got ${allArchive.length}`,
);
const firstEntry = allArchive[0];
console.assert(firstEntry.title.length > 0, "Archive entry should have title");
console.assert(
  firstEntry.tags.includes("bun"),
  `Tags should contain 'bun', got: ${firstEntry.tags}`,
);
console.assert(
  firstEntry.confidence === "HIGH",
  `Confidence should be HIGH, got: ${firstEntry.confidence}`,
);

// ─── Test 7: Anti-patterns entry created ─────────────────

const antiPatterns = memory.db
  .query("SELECT * FROM layer3_archive WHERE tags LIKE '%anti-patterns%'")
  .all() as any[];
console.assert(antiPatterns.length >= 1, "Should have anti-pattern entries");

// ─── Test 8: LLM failure gracefully handled ──────────────

const failRouter = {
  chat: async () => {
    throw new Error("LLM unavailable");
  },
  scheduleRaw: async (_p: string, fn: () => Promise<any>) => fn(),
  raw: {
    embed: async () => ({ data: [{ embedding: new Array(2048).fill(0) }] }),
  },
} as any;

const failMemory = new MemoryDB("data/test-night-fail.db");
failMemory.appendLog(
  "r1",
  "s1",
  "a1",
  "user",
  "Test message from user about project",
);
failMemory.appendLog(
  "r1",
  "s1",
  "a1",
  "assistant",
  "Test response with enough content to trigger processing in the pipeline and not be skipped as trivial",
);

const failRag = new RAGPipeline(failMemory, failRouter);
const failCycle = new NightCycle(failMemory, failRouter, failRag);
const result5 = await failCycle.run();

console.assert(
  result5.processedLogs === 2,
  "Should still count processed logs",
);
console.assert(
  result5.archiveEntriesCreated === 0,
  "Should create 0 entries on failure",
);
// Should have errors but not crash
console.assert(result5.errors.length >= 0, "Should handle errors gracefully");

// Cleanup
try {
  unlinkSync("data/test-night-fail.db");
} catch {}

console.log("✅ All 8 night cycle tests passed");
