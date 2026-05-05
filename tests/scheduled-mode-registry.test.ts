/**
 * SCHED-1: registry.listForAgent(mode) hides code-tool authoring primitives
 * under `scheduled` mode, keeps them under `interactive`, and yields to the
 * `SCHEDULED_ALLOW_CODE_TOOL_CREATE=1` opt-in.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildRegistry, SCHEDULED_HIDDEN_TOOLS } from "@subbrain/agent/mcp/registry";

describe("ToolRegistry.listForAgent (SCHED-1)", () => {
  const savedEnv = process.env.SCHEDULED_ALLOW_CODE_TOOL_CREATE;

  beforeEach(() => {
    delete process.env.SCHEDULED_ALLOW_CODE_TOOL_CREATE;
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.SCHEDULED_ALLOW_CODE_TOOL_CREATE;
    } else {
      process.env.SCHEDULED_ALLOW_CODE_TOOL_CREATE = savedEnv;
    }
  });

  test("interactive mode contains create_tool, create_code_tool, edit_code_tool", () => {
    const registry = buildRegistry();
    const names = new Set(registry.listForAgent("interactive").map((t) => t.name));
    expect(names.has("create_tool")).toBe(true);
    expect(names.has("create_code_tool")).toBe(true);
    expect(names.has("edit_code_tool")).toBe(true);
  });

  test("scheduled mode drops all three authoring primitives", () => {
    const registry = buildRegistry();
    const names = new Set(registry.listForAgent("scheduled").map((t) => t.name));
    expect(names.has("create_tool")).toBe(false);
    expect(names.has("create_code_tool")).toBe(false);
    expect(names.has("edit_code_tool")).toBe(false);
  });

  test("scheduled mode preserves non-authoring code-tool management", () => {
    const registry = buildRegistry();
    const names = new Set(registry.listForAgent("scheduled").map((t) => t.name));
    // Using existing tools is still OK — only creation/edit is blocked.
    for (const keep of ["test_code_tool", "list_code_tools", "delete_code_tool"]) {
      expect(names.has(keep)).toBe(true);
    }
  });

  test("SCHEDULED_ALLOW_CODE_TOOL_CREATE=1 restores interactive parity", () => {
    process.env.SCHEDULED_ALLOW_CODE_TOOL_CREATE = "1";
    const registry = buildRegistry();
    const scheduled = registry.listForAgent("scheduled").map((t) => t.name);
    const interactive = registry.listForAgent("interactive").map((t) => t.name);
    expect(scheduled.sort()).toEqual(interactive.sort());
  });

  test("SCHEDULED_HIDDEN_TOOLS matches documented set", () => {
    expect(new Set(SCHEDULED_HIDDEN_TOOLS)).toEqual(
      new Set(["create_tool", "create_code_tool", "edit_code_tool"]),
    );
  });

  test("toOpenAIToolsForAgent mirrors listForAgent filter", () => {
    const registry = buildRegistry();
    const scheduled = registry.toOpenAIToolsForAgent("scheduled");
    const names = scheduled.map((t) => t.function.name);
    for (const hidden of SCHEDULED_HIDDEN_TOOLS) {
      expect(names).not.toContain(hidden);
    }
  });
});
