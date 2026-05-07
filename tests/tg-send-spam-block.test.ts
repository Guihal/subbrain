/**
 * F-4: tg_send_message must hard-block when layer1_focus.no_repetitive_tg_spam
 * is active and fresh AND ctx.agentMode is "scheduled". Interactive runs and
 * empty/cleared/expired directives must pass through.
 *
 * See docs/tasks/code-tools-poisoning-fix.md and ~/vault/RLM/Daily/2026-04-28.md.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { ToolExecutor } from "@subbrain/agent/mcp/executor";
import { buildRegistry } from "@subbrain/agent/mcp/registry";
import { tgGatesPlugin } from "@subbrain/agent/plugins-internal/tg-gates";
import { MemoryDB } from "@subbrain/core/db";
import type { ModelRouter } from "@subbrain/core/lib/model-router";
import { toLegacy } from "@subbrain/plugin";

const TEST_DB = "data/test-tg-spam-block.db";

function fresh(): { memory: MemoryDB; executor: ToolExecutor } {
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  const memory = new MemoryDB(TEST_DB);
  const executor = new ToolExecutor(memory, {} as ModelRouter);
  // Default to "delivery success" so absence of block path = success.
  executor.setBotNotify(async () => {});
  return { memory, executor };
}

/** Run the tg-gates plugin hook directly (unit-style). */
async function runGate(ctx: {
  executor: ToolExecutor;
  agentMode?: "scheduled" | "interactive";
}): Promise<ReturnType<typeof toLegacy> | undefined> {
  const hooks = { onToolBefore: [] as any[] };
  tgGatesPlugin.setup({
    hooks: {
      onToolBefore(h) {
        hooks.onToolBefore.push(h);
      },
      onToolAfter() {},
      onChatParams() {},
      onChatSystemTransform() {},
      onPermissionAsk() {},
    },
  });
  const handler = hooks.onToolBefore[0];
  const result = await handler({ toolName: "tg_send_message", args: {}, ctx });
  return result ? toLegacy(result) : undefined;
}

describe("tg_send_message focus-block (F-4)", () => {
  let memory: MemoryDB;
  let executor: ToolExecutor;
  beforeEach(() => {
    const f = fresh();
    memory = f.memory;
    executor = f.executor;
  });
  afterEach(() => {
    memory.close();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  });

  test("scheduled + no directive → success", async () => {
    const r = await runGate({ executor, agentMode: "scheduled" });
    expect(r).toBeUndefined();
  });

  test("scheduled + fresh directive → focus_blocked", async () => {
    memory.setFocus("no_repetitive_tg_spam", "user said stop");
    const r = await runGate({ executor, agentMode: "scheduled" });
    expect(r).toBeDefined();
    expect(r?.success).toBe(false);
    expect(r?.error.code).toBe("focus_blocked");
    expect(r?.error.message).toContain("no_repetitive_tg_spam");
  });

  test("scheduled + expired (>7d) directive → success (TTL elapsed)", async () => {
    memory.setFocus("no_repetitive_tg_spam", "stale");
    // Backdate updated_at to 8 days ago.
    const eightDaysAgo = Math.floor(Date.now() / 1000) - 8 * 86400;
    memory.db
      .query("UPDATE layer1_focus SET updated_at = ? WHERE key = ?")
      .run(eightDaysAgo, "no_repetitive_tg_spam");
    const r = await runGate({ executor, agentMode: "scheduled" });
    expect(r).toBeUndefined();
  });

  test("interactive + fresh directive → success (gate skipped)", async () => {
    memory.setFocus("no_repetitive_tg_spam", "user said stop");
    const r = await runGate({ executor, agentMode: "interactive" });
    expect(r).toBeUndefined();
  });

  test("scheduled + whitespace-only value → success (cleared)", async () => {
    memory.setFocus("no_repetitive_tg_spam", "   ");
    const r = await runGate({ executor, agentMode: "scheduled" });
    expect(r).toBeUndefined();
  });

  test("scheduled + clock-skew (updated_at in future) → still blocked", async () => {
    memory.setFocus("no_repetitive_tg_spam", "fresh");
    // Move updated_at 1 hour into the future.
    const future = Math.floor(Date.now() / 1000) + 3600;
    memory.db
      .query("UPDATE layer1_focus SET updated_at = ? WHERE key = ?")
      .run(future, "no_repetitive_tg_spam");
    const r = await runGate({ executor, agentMode: "scheduled" });
    // Math.max(0, ...) keeps the diff at 0 — block remains active.
    expect(r).toBeDefined();
    expect(r?.success).toBe(false);
    expect(r?.error.code).toBe("focus_blocked");
  });

  test("tg_send_message handler still works end-to-end", async () => {
    const registry = buildRegistry();
    const r = await registry.callAsPublic(
      "tg_send_message",
      { text: "ok" },
      { executor, agentId: null, agentMode: "interactive" },
    );
    expect(r.success).toBe(true);
  });
});
