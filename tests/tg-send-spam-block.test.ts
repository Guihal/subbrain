/**
 * F-4: tg_send_message must hard-block when layer1_focus.no_repetitive_tg_spam
 * is active and fresh AND ctx.agentMode is "scheduled". Interactive runs and
 * empty/cleared/expired directives must pass through.
 *
 * See docs/tasks/code-tools-poisoning-fix.md and ~/vault/RLM/Daily/2026-04-28.md.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { unlinkSync, existsSync } from "node:fs";
import { buildRegistry } from "../src/mcp/registry";
import { ToolExecutor } from "../src/mcp/executor";
import { MemoryDB } from "../src/db";
import type { ModelRouter } from "../src/lib/model-router";

const TEST_DB = "data/test-tg-spam-block.db";

function fresh(): { memory: MemoryDB; executor: ToolExecutor } {
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  const memory = new MemoryDB(TEST_DB);
  const executor = new ToolExecutor(memory, {} as ModelRouter);
  // Default to "delivery success" so absence of block path = success.
  executor.setBotNotify(async () => {});
  return { memory, executor };
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
    const registry = buildRegistry();
    const r = await registry.callAsPublic(
      "tg_send_message",
      { text: "ok" },
      { executor, agentId: "free-agent", agentMode: "scheduled" },
    );
    expect(r.success).toBe(true);
  });

  test("scheduled + fresh directive → focus_blocked", async () => {
    memory.setFocus("no_repetitive_tg_spam", "user said stop");
    const registry = buildRegistry();
    const r = await registry.callAsPublic(
      "tg_send_message",
      { text: "spam" },
      { executor, agentId: "free-agent", agentMode: "scheduled" },
    );
    expect(r.success).toBe(false);
    expect(r.error).toContain("focus_blocked");
    expect(r.error).toContain("no_repetitive_tg_spam");
  });

  test("scheduled + expired (>7d) directive → success (TTL elapsed)", async () => {
    memory.setFocus("no_repetitive_tg_spam", "stale");
    // Backdate updated_at to 8 days ago.
    const eightDaysAgo = Math.floor(Date.now() / 1000) - 8 * 86400;
    memory.db
      .query("UPDATE layer1_focus SET updated_at = ? WHERE key = ?")
      .run(eightDaysAgo, "no_repetitive_tg_spam");
    const registry = buildRegistry();
    const r = await registry.callAsPublic(
      "tg_send_message",
      { text: "ok" },
      { executor, agentId: "free-agent", agentMode: "scheduled" },
    );
    expect(r.success).toBe(true);
  });

  test("interactive + fresh directive → success (gate skipped)", async () => {
    memory.setFocus("no_repetitive_tg_spam", "user said stop");
    const registry = buildRegistry();
    const r = await registry.callAsPublic(
      "tg_send_message",
      { text: "user-asked" },
      { executor, agentId: null, agentMode: "interactive" },
    );
    expect(r.success).toBe(true);
  });

  test("scheduled + whitespace-only value → success (cleared)", async () => {
    memory.setFocus("no_repetitive_tg_spam", "   ");
    const registry = buildRegistry();
    const r = await registry.callAsPublic(
      "tg_send_message",
      { text: "ok" },
      { executor, agentId: "free-agent", agentMode: "scheduled" },
    );
    expect(r.success).toBe(true);
  });

  test("scheduled + clock-skew (updated_at in future) → still blocked", async () => {
    memory.setFocus("no_repetitive_tg_spam", "fresh");
    // Move updated_at 1 hour into the future.
    const future = Math.floor(Date.now() / 1000) + 3600;
    memory.db
      .query("UPDATE layer1_focus SET updated_at = ? WHERE key = ?")
      .run(future, "no_repetitive_tg_spam");
    const registry = buildRegistry();
    const r = await registry.callAsPublic(
      "tg_send_message",
      { text: "spam" },
      { executor, agentId: "free-agent", agentMode: "scheduled" },
    );
    // Math.max(0, ...) keeps the diff at 0 — block remains active.
    expect(r.success).toBe(false);
    expect(r.error).toContain("focus_blocked");
  });
});
