import { describe, expect, test } from "bun:test";
import { buildRegistry } from "../src/mcp/registry";

describe("MCP registry smoke", () => {
  const registry = buildRegistry();

  test("builds without duplicate tool registration", () => {
    expect(registry).toBeDefined();
  });

  test("has non-empty public + agent-only lists", () => {
    const pub = registry.list("public");
    const agent = registry.list("agent-only");
    expect(pub.length).toBeGreaterThan(5);
    expect(agent.length).toBeGreaterThan(0);
  });

  test("every tool exposes name + description + TypeBox input schema", () => {
    for (const tool of registry.list()) {
      expect(typeof tool.name).toBe("string");
      expect(tool.name.length).toBeGreaterThan(0);
      expect(typeof tool.description).toBe("string");
      expect(tool.input).toBeDefined();
      expect(["public", "agent-only"]).toContain(tool.scope);
    }
  });

  test("essential public tools present", () => {
    for (const name of [
      "memory_search",
      "memory_write",
      "rag_search",
      "embed_text",
      "web_navigate",
    ]) {
      expect(registry.has(name)).toBe(true);
    }
  });

  test("essential agent-only tools present", () => {
    for (const name of ["done", "think"]) {
      expect(registry.has(name)).toBe(true);
    }
  });

  test("OpenAI schema export is JSON-serializable", () => {
    const schemas = registry.toOpenAITools("agent-only");
    const json = JSON.stringify(schemas);
    expect(json.length).toBeGreaterThan(0);
    const parsed = JSON.parse(json);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]).toHaveProperty("function.name");
  });

  test("unknown tool call returns graceful error, not throw", async () => {
    const res = await registry.callAsPublic(
      "this_tool_does_not_exist",
      {},
      {
        executor: {} as any,
      },
    );
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Unknown tool/);
  });
});
