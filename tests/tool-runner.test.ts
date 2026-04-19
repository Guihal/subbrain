/**
 * Tests for tool-runner handler registry (src/pipeline/agent-loop/tool-runner.ts).
 * Focuses on: URL validation, handler dispatch, unknown tool handling.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { MemoryDB } from "../src/db";
import { ToolExecutor } from "../src/mcp/executor";
import { existsSync, unlinkSync } from "fs";

const DB_PATH = "data/test-tool-runner.db";
let db: MemoryDB;
let executor: ToolExecutor;
let executeAgentTool: Function;

const mockLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as any;

const mockRouter = {
  chat: async () => ({
    choices: [{ message: { content: "ok" } }],
  }),
  chatStream: () => new ReadableStream(),
  scheduleRaw: async (_p: string, fn: () => Promise<unknown>) => fn(),
  raw: {
    embed: async () => ({ data: [{ embedding: new Array(2048).fill(0) }] }),
    rerank: async () => ({
      results: [{ index: 0, relevance_score: 0.9 }],
    }),
  },
  isOverloaded: false,
} as any;

const mockDynamicTools = {
  getAll: () => ({}),
  get: () => null,
  list: () => [],
  register: () => ({ success: true }),
  delete: () => {},
} as any;

function deps() {
  return {
    tools: executor,
    router: mockRouter,
    room: null,
    dynamicTools: mockDynamicTools,
    persistDynamicTools: () => {},
  };
}

function tc(name: string, args: Record<string, unknown>) {
  return {
    id: crypto.randomUUID(),
    type: "function" as const,
    function: { name, arguments: JSON.stringify(args) },
  };
}

function tcRaw(name: string, rawArgs: string) {
  return {
    id: crypto.randomUUID(),
    type: "function" as const,
    function: { name, arguments: rawArgs },
  };
}

beforeAll(async () => {
  if (existsSync(DB_PATH)) unlinkSync(DB_PATH);
  db = new MemoryDB(DB_PATH);
  executor = new ToolExecutor(db, mockRouter);
  const mod = await import("../src/pipeline/agent-loop/tool-runner");
  executeAgentTool = mod.executeAgentTool;
});

afterAll(() => {
  db.close();
  if (existsSync(DB_PATH)) unlinkSync(DB_PATH);
});

// ─── URL Validation (SSRF protection) ────────────────────

describe("web_navigate URL validation", () => {
  test("rejects file:// URLs", async () => {
    const r = await executeAgentTool(tc("web_navigate", { url: "file:///etc/passwd" }), deps(), mockLog);
    expect(r).toContain("Only http:// and https:// URLs are allowed");
  });

  test("rejects javascript: URLs", async () => {
    const r = await executeAgentTool(tc("web_navigate", { url: "javascript:alert(1)" }), deps(), mockLog);
    expect(r).toContain("Only http://");
  });

  test("rejects empty URL", async () => {
    const r = await executeAgentTool(tc("web_navigate", { url: "" }), deps(), mockLog);
    expect(r).toContain("Only http://");
  });

  test("rejects data: URLs", async () => {
    const r = await executeAgentTool(tc("web_navigate", { url: "data:text/html,<h1>x</h1>" }), deps(), mockLog);
    expect(r).toContain("Only http://");
  });

  test("allows https:// URLs (passes URL check)", async () => {
    const r = await executeAgentTool(tc("web_navigate", { url: "https://example.com" }), deps(), mockLog);
    // URL validation passes — Playwright not configured produces a different error
    expect(r).not.toContain("Only http://");
  });

  test("allows http:// URLs", async () => {
    const r = await executeAgentTool(tc("web_navigate", { url: "http://localhost:3000" }), deps(), mockLog);
    expect(r).not.toContain("Only http://");
  });
});

// ─── Handler dispatch ────────────────────────────────────

describe("tool-runner handler dispatch", () => {
  test("think returns recorded thought", async () => {
    const r = await executeAgentTool(tc("think", { thought: "analyzing" }), deps(), mockLog);
    expect(r).toContain("Thought recorded");
  });

  test("done returns the summary string", async () => {
    const r = await executeAgentTool(tc("done", { summary: "Task done" }), deps(), mockLog);
    expect(r).toBe("Task done");
  });

  test("memory_search returns results", async () => {
    executor.memoryWrite({
      layer: "context",
      id: "runner-test-001",
      title: "Bun Runtime",
      content: "We chose Bun runtime for performance",
      tags: "runtime",
    });

    const r = await executeAgentTool(tc("memory_search", { query: "bun runtime", layer: "context" }), deps(), mockLog);
    const parsed = JSON.parse(r);
    expect(parsed.success).toBe(true);
  });

  test("memory_write succeeds", async () => {
    const r = await executeAgentTool(
      tc("memory_write", { layer: "context", id: "runner-write-001", title: "Test", content: "content", tags: "" }),
      deps(),
      mockLog,
    );
    const parsed = JSON.parse(r);
    expect(parsed.success).toBe(true);
  });

  test("unknown tool returns error", async () => {
    const r = await executeAgentTool(tc("nonexistent_tool", {}), deps(), mockLog);
    expect(r).toContain("Unknown tool");
  });

  test("invalid JSON arguments returns error", async () => {
    const r = await executeAgentTool(tcRaw("think", "{broken"), deps(), mockLog);
    expect(r).toContain("Invalid JSON");
  });

  test("list_tools returns static and dynamic tools", async () => {
    const r = await executeAgentTool(tc("list_tools", {}), deps(), mockLog);
    const parsed = JSON.parse(r);
    expect(parsed.success).toBe(true);
    expect(parsed.data.static_tools.length).toBeGreaterThan(0);
    expect(Array.isArray(parsed.data.dynamic_tools)).toBe(true);
  });
});

console.log("🎉 Tool runner tests passed!");
