import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { MemoryDB } from "@subbrain/core/db";
import type { ToolContext } from "../src/mcp/registry/tool-registry";
import { sendReport } from "../src/mcp/tools/telegram-report";
import type { ToolResult } from "../src/mcp/types";
import { buildReportContext, truncateReportContext } from "../src/rag/report-context";

const TEST_DB = "data/test-report-context.db";

function freshDb(): MemoryDB {
  try {
    unlinkSync(TEST_DB);
  } catch {}
  return new MemoryDB(TEST_DB);
}

describe("buildReportContext", () => {
  let memory: MemoryDB;
  const now = 1_700_000_000_000; // 2023-11-14

  beforeEach(() => {
    memory = freshDb();
  });

  afterEach(() => {
    memory.close();
    try {
      unlinkSync(TEST_DB);
    } catch {}
  });

  test("section order: Facts → Events → Related context", async () => {
    memory.insertShared("sh-1", "preference", "User prefers Bun over Node");
    memory.appendLog("req-1", "sess-1", "teamlead", "user", "Plan report on Q4");

    const md = await buildReportContext({
      memory,
      topic: "bun",
      sinceHours: 24,
      nowMs: now,
    });

    const idxFacts = md.indexOf("## Факты");
    const idxEvents = md.indexOf("## Последние события");
    expect(idxFacts).toBeGreaterThanOrEqual(0);
    expect(idxEvents).toBeGreaterThan(idxFacts);
  });

  test("empty sections are omitted, no dangling header", async () => {
    // No memory, no logs at all.
    const md = await buildReportContext({
      memory,
      topic: "whatever",
      nowMs: now,
    });
    expect(md).not.toContain("## Факты\n\n");
    expect(md).not.toContain("## Последние события\n\n");
    expect(md).toBe("");
  });

  test("filters out technical stream-chunk rows", async () => {
    const tsNow = Math.floor(now / 1000);
    memory.db
      .query(
        "INSERT INTO layer4_log (request_id, session_id, agent_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("r1", "s1", "coder", "user", "Real user message", tsNow - 60);
    memory.db
      .query(
        "INSERT INTO layer4_log (request_id, session_id, agent_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("r1", "s1", "coder", "tool", "stream-chunk partial", tsNow - 30);

    const md = await buildReportContext({ memory, topic: "", nowMs: now });
    expect(md).toContain("Real user message");
    expect(md).not.toContain("stream-chunk");
  });

  test("since_hours excludes old rows", async () => {
    const tsNow = Math.floor(now / 1000);
    memory.db
      .query(
        "INSERT INTO layer4_log (request_id, session_id, agent_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("r1", "s1", "coder", "user", "fresh entry", tsNow - 60);
    memory.db
      .query(
        "INSERT INTO layer4_log (request_id, session_id, agent_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("r1", "s1", "coder", "user", "ancient entry", tsNow - 72 * 3600);

    const md = await buildReportContext({
      memory,
      topic: "",
      sinceHours: 24,
      nowMs: now,
    });
    expect(md).toContain("fresh entry");
    expect(md).not.toContain("ancient entry");
  });
});

describe("truncateReportContext", () => {
  test("drops Events then Related before Facts", () => {
    const facts = `## Факты\n- ${"f".repeat(50)}`;
    const events = `## Последние события\n- ${"e".repeat(1000)}`;
    const related = `## Связанный контекст\n- ${"r".repeat(1000)}`;
    const full = [facts, events, related].join("\n\n");

    const trimmed = truncateReportContext(full, 200);
    expect(trimmed).toContain("## Факты");
    expect(trimmed).not.toContain("## Последние события");
    expect(trimmed).not.toContain("## Связанный контекст");
  });

  test("returns original when already small", () => {
    const input = "## Факты\n- one";
    expect(truncateReportContext(input, 10_000)).toBe(input);
  });
});

describe("sendReport kill-switch", () => {
  const originalEnv = process.env.REPORT_RAG;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.REPORT_RAG;
    else process.env.REPORT_RAG = originalEnv;
  });

  test("REPORT_RAG=false skips enrichment and calls send raw", async () => {
    process.env.REPORT_RAG = "false";
    const sent: string[] = [];
    let enrichCalls = 0;

    const ctx = {
      executor: {
        tgSendMessage: async (text: string): Promise<ToolResult> => {
          sent.push(text);
          return { success: true };
        },
      },
    } as unknown as ToolContext;

    const result = await sendReport(ctx, "hello", {
      buildContext: async () => {
        enrichCalls++;
        return "## Факты\n- nope";
      },
    });
    expect(result.success).toBe(true);
    expect(enrichCalls).toBe(0);
    expect(sent).toEqual(["hello"]);
  });

  test("REPORT_RAG=true prepends enriched context", async () => {
    process.env.REPORT_RAG = "true";
    const sent: string[] = [];
    const ctx = {
      executor: {
        tgSendMessage: async (text: string): Promise<ToolResult> => {
          sent.push(text);
          return { success: true };
        },
      },
    } as unknown as ToolContext;

    await sendReport(ctx, "body", {
      buildContext: async () => "## Факты\n- fact one",
    });

    expect(sent.length).toBe(1);
    expect(sent[0]).toContain("## Факты");
    expect(sent[0]).toContain("---");
    expect(sent[0]).toContain("body");
  });
});
