/**
 * Tests for MCP domain tool modules (src/mcp/tools/).
 * Tests MemoryTools, LogTools, WebTools with mocked dependencies.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { MemoryDB } from "../src/db";
import { MemoryTools } from "../src/mcp/tools/memory-tools";
import { LogTools } from "../src/mcp/tools/log-tools";
import { WebTools } from "../src/mcp/tools/web-tools";
import { existsSync, unlinkSync } from "fs";

const DB_PATH = "data/test-tools.db";
let db: MemoryDB;

beforeAll(() => {
  if (existsSync(DB_PATH)) unlinkSync(DB_PATH);
  db = new MemoryDB(DB_PATH);
});

afterAll(() => {
  db.close();
  if (existsSync(DB_PATH)) unlinkSync(DB_PATH);
});

// ─── MemoryTools ─────────────────────────────────────────

describe("MemoryTools", () => {
  let tools: MemoryTools;

  beforeAll(() => {
    tools = new MemoryTools(db, () => null);
  });

  test("write + read — focus layer", () => {
    const w = tools.write({
      layer: "focus",
      key: "test_focus_key",
      content: "focus value 123",
    });
    expect(w.success).toBe(true);
    expect((w.data as { key: string }).key).toBe("test_focus_key");

    // Read via db directly (focus doesn't use IDs)
    const val = db.getFocus("test_focus_key");
    expect(val).toBe("focus value 123");
  });

  test("write + read — context layer", () => {
    const w = tools.write({
      layer: "context",
      id: "ctx-test-001",
      title: "Test Context",
      content: "Context content here",
      tags: "test",
    });
    expect(w.success).toBe(true);

    const r = tools.read("ctx-test-001", "context");
    expect(r.success).toBe(true);
    expect((r.data as { content: string }).content).toBe(
      "Context content here",
    );
  });

  test("write — context upsert updates existing", () => {
    tools.write({
      layer: "context",
      id: "ctx-test-001",
      title: "Updated Title",
      content: "Updated content",
      tags: "updated",
    });
    const r = tools.read("ctx-test-001", "context");
    expect((r.data as { content: string }).content).toBe("Updated content");
  });

  test("write + read — shared layer", () => {
    const w = tools.write({
      layer: "shared",
      id: "shared-001",
      category: "preferences",
      content: "User likes Bun",
      tags: "runtime",
    });
    expect(w.success).toBe(true);

    const r = tools.read("shared-001", "shared");
    expect(r.success).toBe(true);
  });

  test("write + read — archive layer", () => {
    const w = tools.write({
      layer: "archive",
      id: "arch-001",
      title: "Archived Knowledge",
      content: "Historical data about project",
      tags: "history",
      confidence: "HIGH",
    });
    expect(w.success).toBe(true);

    const r = tools.read("arch-001", "archive");
    expect(r.success).toBe(true);
  });

  test("write — agent layer requires agent_id", () => {
    const w = tools.write({
      layer: "agent",
      content: "Agent note",
    });
    expect(w.success).toBe(false);
    expect(w.error).toContain("agent_id");
  });

  test("write + read — agent layer", () => {
    const w = tools.write({
      layer: "agent",
      id: "agent-001",
      agent_id: "critic",
      content: "Critic's note",
      tags: "review",
    });
    expect(w.success).toBe(true);

    const r = tools.read("agent-001", "agent");
    expect(r.success).toBe(true);
  });

  test("write — focus layer requires key", () => {
    const w = tools.write({ layer: "focus", content: "no key" });
    expect(w.success).toBe(false);
    expect(w.error).toContain("key required");
  });

  test("write — unknown layer returns error", () => {
    const w = tools.write({ layer: "nonexistent", content: "x" });
    expect(w.success).toBe(false);
    expect(w.error).toContain("Unknown layer");
  });

  test("read — unfound ID returns error", () => {
    const r = tools.read("does-not-exist");
    expect(r.success).toBe(false);
    expect(r.error).toBe("Not found");
  });

  test("read — no layer searches all layers", () => {
    // "ctx-test-001" was inserted to context
    const r = tools.read("ctx-test-001");
    expect(r.success).toBe(true);
  });

  test("delete — context layer", () => {
    tools.write({
      layer: "context",
      id: "ctx-del-001",
      title: "Delete Me",
      content: "Will be deleted",
    });
    const d = tools.delete("ctx-del-001", "context");
    expect(d.success).toBe(true);

    const r = tools.read("ctx-del-001", "context");
    expect(r.success).toBe(false);
  });

  test("delete — unknown layer returns error", () => {
    const d = tools.delete("x", "nonexistent");
    expect(d.success).toBe(false);
    expect(d.error).toContain("Unknown layer");
  });

  test("search — FTS5 finds matching content", () => {
    tools.write({
      layer: "context",
      id: "ctx-search-001",
      title: "SQLite FTS5",
      content: "Full text search engine SQLite for Subbrain",
      tags: "search",
    });
    const s = tools.search("sqlite", "context");
    expect(s.success).toBe(true);
    const ctx = (s.data as { context: unknown[] }).context;
    expect(ctx.length).toBeGreaterThan(0);
  });

  test("search — all layers when no layer specified", () => {
    const s = tools.search("content");
    expect(s.success).toBe(true);
    const data = s.data as Record<string, unknown[]>;
    expect(data).toHaveProperty("context");
    expect(data).toHaveProperty("archive");
    expect(data).toHaveProperty("shared");
  });

  test("contextSummary — returns focus + logs", () => {
    const r = tools.contextSummary("session-test");
    expect(r.success).toBe(true);
    const data = r.data as { focus: unknown; recent_log_count: number };
    expect(data).toHaveProperty("focus");
    expect(data).toHaveProperty("recent_log_count");
    expect(data).toHaveProperty("recent_logs");
  });
});

// ─── LogTools ────────────────────────────────────────────

describe("LogTools", () => {
  let logTools: LogTools;
  const mockRouter = {
    chat: async () => ({
      choices: [{ message: { content: "# Summary\nDecision: use Bun" } }],
    }),
    scheduleRaw: async (_p: string, fn: () => Promise<unknown>) => fn(),
    raw: { embed: async () => ({ data: [] }), rerank: async () => ({}) },
  } as any;

  beforeAll(() => {
    logTools = new LogTools(db, mockRouter);
  });

  test("append + read by request", () => {
    logTools.append("req-001", "sess-001", "coder", "user", "Hello", 5);
    logTools.append(
      "req-001",
      "sess-001",
      "coder",
      "assistant",
      "Hi there!",
      10,
    );

    const r = logTools.read(undefined, "req-001");
    expect(r.success).toBe(true);
    expect((r.data as unknown[]).length).toBe(2);
  });

  test("read by session", () => {
    const r = logTools.read("sess-001");
    expect(r.success).toBe(true);
    expect((r.data as unknown[]).length).toBeGreaterThan(0);
  });

  test("read without session or request returns error", () => {
    const r = logTools.read();
    expect(r.success).toBe(false);
    expect(r.error).toContain("required");
  });

  test("compressHistory calls flash model", async () => {
    const r = await logTools.compressHistory([
      { role: "user", content: "What runtime to use?" },
      { role: "assistant", content: "Use Bun for speed." },
    ]);
    expect(r.success).toBe(true);
    expect((r.data as { summary: string }).summary).toContain("Bun");
  });
});

// ─── WebTools ────────────────────────────────────────────

describe("WebTools", () => {
  test("callTool without playwright returns error JSON", async () => {
    const wt = new WebTools();
    const result = await wt.callTool("browser_navigate", {
      url: "https://example.com",
    });
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("not configured");
  });

  test("callTool with mock playwright delegates correctly", async () => {
    const wt = new WebTools();
    const mockPw = {
      callTool: async (name: string, args: Record<string, unknown>) =>
        JSON.stringify({ tool: name, args }),
    };
    wt.setPlaywright(mockPw as any);

    const result = await wt.callTool("browser_snapshot", {});
    const parsed = JSON.parse(result);
    expect(parsed.tool).toBe("browser_snapshot");
  });
});

console.log("🎉 MCP tools tests passed!");
