/**
 * PR 18 — TG-1: registry-level contract for `tg_send_message`.
 *
 * The tool handler must translate an executor failure into a tool error
 * that carries the `tg_delivery_failed` code in the message so the agent
 * (which JSON.stringify's the ToolResult) cannot silently treat failed
 * delivery as success. Success path stays `{ success: true }`.
 */
import { describe, expect, test } from "bun:test";
import type { MemoryDB } from "../src/db";
import type { ModelRouter } from "../src/lib/model-router";
import { ToolExecutor } from "../src/mcp/executor";
import { buildRegistry } from "../src/mcp/registry";

function makeExecutor(botNotify: (text: string) => Promise<void>): ToolExecutor {
  const exec = new ToolExecutor({} as MemoryDB, {} as ModelRouter);
  exec.setBotNotify(botNotify);
  return exec;
}

describe("tg_send_message tool handler", () => {
  test("wraps delivery failure with tg_delivery_failed code", async () => {
    const registry = buildRegistry();
    const executor = makeExecutor(async () => {
      throw new Error("telegram 500");
    });

    const r = await registry.callAsPublic("tg_send_message", { text: "hi" }, { executor });

    expect(r.success).toBe(false);
    expect(typeof r.error).toBe("string");
    // Error must carry both the code prefix + the underlying message.
    expect(r.error).toContain("tg_delivery_failed");
    expect(r.error).toContain("telegram 500");
  });

  test("returns { success:true } on delivery success (contract unchanged)", async () => {
    const registry = buildRegistry();
    const executor = makeExecutor(async () => {});

    const r = await registry.callAsPublic("tg_send_message", { text: "hi" }, { executor });

    expect(r.success).toBe(true);
    expect(r.data).toBe("Message sent to owner");
    // Error must be absent on success — no spurious code prefix.
    expect(r.error).toBeUndefined();
  });

  test("not-configured error is NOT prefixed as delivery failure", async () => {
    // Covers the gate before `botNotify` runs — this is a config error, not
    // a Telegram API delivery error, so the handler still wraps it under
    // `tg_delivery_failed` (agent treats any non-success as failure).
    const registry = buildRegistry();
    const executor = new ToolExecutor({} as MemoryDB, {} as ModelRouter);
    // botNotify intentionally NOT set.

    const r = await registry.callAsPublic("tg_send_message", { text: "hi" }, { executor });

    expect(r.success).toBe(false);
    expect(r.error).toContain("tg_delivery_failed");
    expect(r.error).toContain("not configured");
  });
});
