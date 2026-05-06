/**
 * A2-6 integration test: code-tool-guards plugin reproduces F-2 poisoning
 * case via the hook path.
 */
import { describe, expect, test } from "bun:test";
import { codeToolGuardsPlugin } from "@subbrain/agent/plugins-internal/code-tool-guards";
import { toLegacy } from "@subbrain/plugin";

function makeHooks() {
  const before: any[] = [];
  codeToolGuardsPlugin.setup({
    hooks: {
      onToolBefore(h) {
        before.push(h);
      },
      onToolAfter() {},
      onChatParams() {},
      onChatSystemTransform() {},
      onPermissionAsk() {},
    },
  });
  return { before };
}

const noopLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLog,
} as const;

function makeCtx(log = noopLog) {
  return { log };
}

describe("code-tool-guards plugin", () => {
  test("registers one onToolBefore handler", () => {
    const { before } = makeHooks();
    expect(before.length).toBe(1);
  });

  test("ignores non-code-tool tools", async () => {
    const { before } = makeHooks();
    const handler = before[0];
    const result = await handler({
      toolName: "memory_search",
      args: { q: "test" },
      ctx: makeCtx(),
    });
    expect(result).toBeUndefined();
  });

  test("create_code_tool clean code → pass (undefined)", async () => {
    const { before } = makeHooks();
    const handler = before[0];
    const result = await handler({
      toolName: "create_code_tool",
      args: { name: "ok-tool", code: `export default async (i) => i.toUpperCase()` },
      ctx: makeCtx(),
    });
    expect(result).toBeUndefined();
  });

  test("edit_code_tool clean code → pass (undefined)", async () => {
    const { before } = makeHooks();
    const handler = before[0];
    const result = await handler({
      toolName: "edit_code_tool",
      args: { name: "ok-tool", code: `export default async (i) => i.toUpperCase()` },
      ctx: makeCtx(),
    });
    expect(result).toBeUndefined();
  });

  test("sandbox violation (require) → rejected with sandbox_violation", async () => {
    const { before } = makeHooks();
    const handler = before[0];
    const result = await handler({
      toolName: "create_code_tool",
      args: { name: "bad", code: `const fs = require('fs');` },
      ctx: makeCtx(),
    });
    expect(result).toBeDefined();
    expect(result?.kind).toBe("rejected");
    expect(result?.error.code).toBe("sandbox_violation");
    expect(result?.error.message).toContain("sandbox_violation");
    const legacy = toLegacy(result!);
    expect(legacy.success).toBe(false);
  });

  test("hardcoded facts >=2 → rejected with hardcoded_facts", async () => {
    const { before } = makeHooks();
    const handler = before[0];
    const code = `const c = { name: 'Александр', chat_id: 534632085 };`;
    const result = await handler({
      toolName: "create_code_tool",
      args: { name: "bad", code },
      ctx: makeCtx(),
    });
    expect(result).toBeDefined();
    expect(result?.kind).toBe("rejected");
    expect(result?.error.code).toBe("hardcoded_facts");
    expect(result?.error.message).toContain("hardcoded_facts");
    expect(result?.error.message).toContain("person-name");
    const legacy = toLegacy(result!);
    expect(legacy.success).toBe(false);
  });

  test("real overdue_reminder snapshot → reject, >=3 labels", async () => {
    const { before } = makeHooks();
    const handler = before[0];
    const code = `
      const critical = [
        { name: "Артём", chat_id: "1755145821", overdue_hours: 18,
          lastAction: "24.04 10:14 окей" },
      ];
    `;
    const result = await handler({
      toolName: "create_code_tool",
      args: { name: "bad", code },
      ctx: makeCtx(),
    });
    expect(result).toBeDefined();
    expect(result?.kind).toBe("rejected");
    expect(result?.error.code).toBe("hardcoded_facts");
    expect(result?.error.message).toContain("person-name");
    expect(result?.error.message).toContain("overdue-hours-literal");
  });

  test("1 match → warn-and-accept (undefined return)", async () => {
    const { before } = makeHooks();
    const handler = before[0];
    let warned = false;
    const log = {
      ...noopLog,
      warn: () => {
        warned = true;
      },
    };
    const result = await handler({
      toolName: "create_code_tool",
      args: { name: "warn-tool", code: `export default async () => 'hello Дмитрий'` },
      ctx: makeCtx(log),
    });
    expect(result).toBeUndefined();
    expect(warned).toBe(true);
  });

  test("edit_code_tool with no code arg → pass (undefined)", async () => {
    const { before } = makeHooks();
    const handler = before[0];
    const result = await handler({
      toolName: "edit_code_tool",
      args: { name: "ok-tool", description: "new desc" },
      ctx: makeCtx(),
    });
    expect(result).toBeUndefined();
  });

  test("missing log in ctx → pass (undefined, no crash)", async () => {
    const { before } = makeHooks();
    const handler = before[0];
    const result = await handler({
      toolName: "create_code_tool",
      args: { name: "bad", code: `const c = { name: 'Александр', chat_id: 534632085 };` },
      ctx: {},
    });
    expect(result).toBeUndefined();
  });
});
