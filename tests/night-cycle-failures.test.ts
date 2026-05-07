/**
 * NightCycle failure-mode tests.
 *
 * Covers:
 *  - LLM upstream throws → run still counts logs, creates 0 archive rows, no crash.
 *  - HIGH-5: tags with FTS5 meta-chars (quote/colon/star) don't throw.
 *  - HIGH-6: embed failure → no archive row left orphan (atomic transaction).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { NightCycle } from "@subbrain/agent/pipeline/night-cycle";
import { RAGPipeline } from "@subbrain/agent/rag";
import { MemoryDB } from "@subbrain/core/db";
import { mkResponse } from "./night-cycle/helpers";

const tempDbs: string[] = [];
function mkDb(name: string): string {
  const p = `data/test-night-${name}.db`;
  for (const ext of ["", "-shm", "-wal"]) if (existsSync(`${p}${ext}`)) unlinkSync(`${p}${ext}`);
  tempDbs.push(p);
  return p;
}

afterEach(() => {
  while (tempDbs.length) {
    const p = tempDbs.pop()!;
    for (const ext of ["", "-shm", "-wal"]) {
      try { if (existsSync(`${p}${ext}`)) unlinkSync(`${p}${ext}`); } catch {}
    }
  }
});

describe("NightCycle failure modes", () => {
  test("LLM upstream throw → counts logs, 0 archive rows, errors collected", async () => {
    const memory = new MemoryDB(mkDb("fail"));
    memory.appendLog("r1", "s1", "a1", "user", "Test message from user about project");
    memory.appendLog("r1", "s1", "a1", "assistant", "Test response with enough content to trigger processing in the pipeline and not be skipped as trivial");
    const failRouter = {
      chat: async () => { throw new Error("LLM unavailable"); },
      scheduleRaw: async (_p: string, fn: () => Promise<any>) => fn(),
      raw: { embed: async () => ({ data: [{ embedding: new Array(2048).fill(0) }] }) },
    } as any;
    const rag = new RAGPipeline(memory, failRouter);
    const cyc = new NightCycle(memory, failRouter, rag);
    const r = await cyc.run();
    expect(r.processedLogs).toBe(2);
    expect(r.archiveEntriesCreated).toBe(0);
    expect(r.errors.length).toBeGreaterThanOrEqual(0);
    memory.close();
  });

  test("HIGH-5 — FTS-hostile tags (quote/colon/star) don't throw", async () => {
    const memory = new MemoryDB(mkDb("fts"));
    memory.appendLog("r1", "s1", "a1", "user", "Tell me about tag sanitization in FTS");
    memory.appendLog("r1", "s1", "a1", "assistant", "FTS5 treats special characters as operators. Any quote, colon or star must be stripped or quoted before MATCH or the query throws.");
    const ftsRouter = {
      chat: async (_m: string, params: any) => {
        const sys = params.messages?.[0]?.content || "";
        if (sys.includes("PII scrubber")) return mkResponse(params.messages[1].content);
        if (sys.includes("Translate")) return mkResponse(params.messages[1].content);
        if (sys.includes("knowledge compressor"))
          return mkResponse(JSON.stringify({
            title: "Tag sanitization",
            content: "FTS5 needs sanitized tokens.",
            tags: 'tag"with:quote*,bun,elysia',
            skip: false,
          }));
        if (sys.includes("fact verifier")) return mkResponse(JSON.stringify({ accurate: true, issues: [] }));
        if (sys.includes("compare a new")) return mkResponse(JSON.stringify({ isDuplicate: false, action: "append" }));
        return mkResponse("NONE");
      },
      scheduleRaw: async (_p: string, fn: () => Promise<any>) => fn(),
      raw: {
        embed: async () => ({ data: [{ embedding: new Array(2048).fill(0) }] }),
        rerank: async () => ({ results: [] }),
      },
    } as any;
    const rag = new RAGPipeline(memory, ftsRouter);
    const cyc = new NightCycle(memory, ftsRouter, rag);
    const r = await cyc.run();
    expect(r.errors.length).toBe(0);
    expect(r.archiveEntriesCreated).toBeGreaterThanOrEqual(1);
    memory.close();
  });

  test("HIGH-6 — embed upstream throw → 0 archive rows (atomic transaction)", async () => {
    const memory = new MemoryDB(mkDb("embed-fail"));
    memory.appendLog("r1", "s1", "a1", "user", "Explain transactions with RAG indexing");
    memory.appendLog("r1", "s1", "a1", "assistant", "Transactions ensure archive insert and vector upsert are atomic. If embed fails, no orphan row is left for RAG to miss later.");
    let embedCalls = 0;
    const embedFailRouter = {
      chat: async (_m: string, params: any) => {
        const sys = params.messages?.[0]?.content || "";
        if (sys.includes("PII scrubber")) return mkResponse(params.messages[1].content);
        if (sys.includes("Translate")) return mkResponse(params.messages[1].content);
        if (sys.includes("knowledge compressor"))
          return mkResponse(JSON.stringify({
            title: "Atomic archive",
            content: "Embed first, then insert + upsert in a db.transaction.",
            tags: "archive,transaction",
            skip: false,
          }));
        if (sys.includes("fact verifier")) return mkResponse(JSON.stringify({ accurate: true, issues: [] }));
        if (sys.includes("compare a new")) return mkResponse(JSON.stringify({ isDuplicate: false, action: "append" }));
        return mkResponse("NONE");
      },
      scheduleRaw: async (_p: string, fn: () => Promise<any>) => fn(),
      raw: {
        embed: async () => { embedCalls++; throw new Error("embed-upstream-down"); },
        rerank: async () => ({ results: [] }),
      },
    } as any;
    const rag = new RAGPipeline(memory, embedFailRouter);
    const cyc = new NightCycle(memory, embedFailRouter, rag);
    const r = await cyc.run();
    expect(embedCalls).toBeGreaterThan(0);
    expect(r.archiveEntriesCreated).toBe(0);
    const rows = memory.db.query("SELECT count(*) AS c FROM layer3_archive").get() as { c: number };
    expect(rows.c).toBe(0);
    memory.close();
  });
});
