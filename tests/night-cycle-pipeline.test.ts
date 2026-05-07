/**
 * NightCycle pipeline tests — happy path. Empty no-op, full PII → translate →
 * compress → verify → dedup → archive, progress tracking, anti-patterns.
 * Mock router, no live API. Sequential state — shared MemoryDB.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { NightCycle } from "@subbrain/agent/pipeline/night-cycle";
import { RAGPipeline } from "@subbrain/agent/rag";
import { MemoryDB } from "@subbrain/core/db";
import { mkResponse } from "./night-cycle/helpers";

const TEST_DB = "data/test-night-cycle.db";
let memory: MemoryDB;
let nightCycle: NightCycle;
let callCount = 0;
let chatCalls: { model: string; systemContent: string }[] = [];

function cleanup(p: string) {
  for (const e of ["", "-shm", "-wal"]) if (existsSync(`${p}${e}`)) unlinkSync(`${p}${e}`);
}

beforeAll(() => {
  cleanup(TEST_DB);
  memory = new MemoryDB(TEST_DB);
  const router = {
    chat: async (model: string, params: any) => {
      callCount++;
      const sys = params.messages?.[0]?.content || "";
      chatCalls.push({ model, systemContent: sys });
      if (sys.includes("PII scrubber"))
        return mkResponse(params.messages[1].content.replace(/John Doe/g, "[NAME]"));
      if (sys.includes("Translate")) return mkResponse(params.messages[1].content);
      if (sys.includes("knowledge compressor"))
        return mkResponse(
          JSON.stringify({
            title: "Bun + Elysia Architecture",
            content: "## Decision\nChose Bun + Elysia for fast HTTP with SQLite.",
            tags: "bun,elysia,architecture",
            skip: false,
          }),
        );
      if (sys.includes("fact verifier"))
        return mkResponse(JSON.stringify({ accurate: true, issues: [] }));
      if (sys.includes("compare a new knowledge"))
        return mkResponse(JSON.stringify({ isDuplicate: false, action: "append" }));
      if (sys.includes("анти-паттерны"))
        return mkResponse(
          "## Anti-patterns detected\n- FTS5 stop words: forgot to sanitize queries, lost 30min debugging",
        );
      if (sys.includes("contradiction"))
        return mkResponse(JSON.stringify({ hasContradiction: false }));
      return mkResponse("ok");
    },
    scheduleRaw: async (_p: string, fn: () => Promise<any>) => fn(),
    raw: {
      embed: async () => ({ data: [{ embedding: new Array(2048).fill(0) }] }),
      rerank: async () => ({ results: [{ index: 0, relevance_score: 0.9 }] }),
    },
  } as any;
  nightCycle = new NightCycle(memory, router, new RAGPipeline(memory, router));
});

afterAll(() => {
  memory.close();
  cleanup(TEST_DB);
});

describe("NightCycle pipeline", () => {
  test("empty logs → no-op (0 processed, 0 sessions, 0 LLM calls)", async () => {
    callCount = 0;
    chatCalls = [];
    const r = await nightCycle.run();
    expect(r.processedLogs).toBe(0);
    expect(r.sessionsProcessed).toBe(0);
    expect(callCount).toBe(0);
  });

  test("full pipeline processes seeded session through PII + compress stages", async () => {
    const sid = "session-001";
    memory.appendLog(
      "req-001",
      sid,
      "teamlead",
      "user",
      "Why did John Doe choose Bun and Elysia for the server?",
    );
    memory.appendLog(
      "req-001",
      sid,
      "teamlead",
      "assistant",
      "Bun was chosen for its fast startup and native SQLite support. Elysia provides a modern HTTP API with excellent TypeScript integration and WebSocket/SSE support.",
    );
    memory.appendLog("req-002", sid, "teamlead", "user", "What about the database choice?");
    memory.appendLog(
      "req-002",
      sid,
      "teamlead",
      "assistant",
      "SQLite with FTS5 for full-text search and sqlite-vec for vector embeddings. This keeps everything in a single process with no external dependencies.",
    );

    callCount = 0;
    chatCalls = [];
    const r = await nightCycle.run();

    expect(r.processedLogs).toBe(4);
    expect(r.sessionsProcessed).toBe(1);
    expect(r.archiveEntriesCreated).toBeGreaterThanOrEqual(1);
    expect(r.errors.length).toBe(0);
    expect(r.lastProcessedId).toBeGreaterThan(0);

    const stages = chatCalls.map((c) => {
      if (c.systemContent.includes("PII")) return "pii";
      if (c.systemContent.includes("compressor")) return "compress";
      return "other";
    });
    expect(stages).toContain("pii");
    expect(stages).toContain("compress");
  });

  test("re-run after processed → 0 new logs, 0 LLM calls", async () => {
    callCount = 0;
    const r = await nightCycle.run();
    expect(r.processedLogs).toBe(0);
    expect(callCount).toBe(0);
  });

  test("progress saved in focus key night_cycle_last_processed_id", () => {
    const saved = memory.getFocus("night_cycle_last_processed_id");
    expect(saved).not.toBeNull();
    expect(Number.parseInt(saved!, 10)).toBeGreaterThan(0);
  });

  test("new logs appended after progress get processed", async () => {
    memory.appendLog("req-003", "session-002", "coder", "user", "New message after night cycle");
    memory.appendLog(
      "req-003",
      "session-002",
      "coder",
      "assistant",
      "This is a detailed response about new architecture decisions including database migration strategies and deployment workflows for the production environment.",
    );

    callCount = 0;
    const r = await nightCycle.run();
    expect(r.processedLogs).toBe(2);
    expect(r.sessionsProcessed).toBe(1);
  });

  test("archive entry written with title, bun tag, confidence=0.9 (M-12 mig 15)", () => {
    const rows = memory.db
      .query(
        "SELECT * FROM layer3_archive WHERE agent_id = 'night-cycle' AND tags NOT LIKE '%anti-patterns%' ORDER BY rowid",
      )
      .all() as any[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const first = rows[0];
    expect(first.title.length).toBeGreaterThan(0);
    expect(first.tags).toContain("bun");
    expect(first.confidence).toBe(0.9);
  });

  test("anti-patterns archive entry created", () => {
    const rows = memory.db
      .query("SELECT * FROM layer3_archive WHERE tags LIKE '%anti-patterns%'")
      .all() as any[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});
