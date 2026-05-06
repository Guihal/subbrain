/**
 * PR 18 — TG-1: `tg_send_message` must fail honestly when Telegram API errors.
 *
 * Covers:
 *   - TelegramBot.notifyOrThrow rethrows sendMessage errors.
 *   - TelegramBot.notify swallows them (fire-and-forget contract).
 *   - ToolExecutor.tgSendMessage returns { success:false, error } when
 *     botNotify throws (i.e. when wired to notifyOrThrow).
 */
import { describe, expect, test } from "bun:test";
import { ToolExecutor } from "@subbrain/agent/mcp/executor";
import type { AgentPipeline } from "@subbrain/agent/pipeline";
import { TelegramBot } from "@subbrain/agent/telegram/bot";
import type { MemoryDB } from "@subbrain/core/db";
import type { ModelRouter } from "@subbrain/core/lib/model-router";

// Stub grammy Bot that never touches the network.
function makeBot(opts: { throwOnSend?: Error } = {}): TelegramBot {
  const bot = new TelegramBot({
    token: "1:test",
    ownerChatId: 42,
    webhookSecret: "secret",
    memory: {} as MemoryDB,
    pipeline: {} as AgentPipeline,
    router: {} as ModelRouter,
  });
  // Swap grammy's real api with a spy/stub — constructor already built
  // the underlying Bot, but we only use bot.api.sendMessage for notify*.
  const calls: unknown[][] = [];
  (bot as unknown as { bot: { api: { sendMessage: unknown } } }).bot.api = {
    sendMessage: async (...args: unknown[]) => {
      calls.push(args);
      if (opts.throwOnSend) throw opts.throwOnSend;
      return { message_id: 1 };
    },
  } as never;
  (bot as unknown as { _testCalls: unknown[][] })._testCalls = calls;
  return bot;
}

describe("TelegramBot.notifyOrThrow", () => {
  test("rethrows sendMessage error", async () => {
    const bot = makeBot({ throwOnSend: new Error("telegram 500") });
    await expect(bot.notifyOrThrow("hi")).rejects.toThrow("telegram 500");
  });

  test("resolves on success + forwards Markdown parse_mode", async () => {
    const bot = makeBot();
    await bot.notifyOrThrow("hi");
    const calls = (bot as unknown as { _testCalls: unknown[][] })._testCalls;
    expect(calls).toHaveLength(1);
    // [ownerChatId, text, { parse_mode: "Markdown" }]
    expect(calls[0][0]).toBe(42);
    expect(calls[0][1]).toBe("hi");
    expect((calls[0][2] as { parse_mode: string }).parse_mode).toBe("Markdown");
  });
});

describe("TelegramBot.notify (fire-and-forget)", () => {
  test("swallows sendMessage error instead of throwing", async () => {
    const bot = makeBot({ throwOnSend: new Error("telegram 500") });
    // Must resolve without throwing so digests keep the current flow.
    await expect(bot.notify("hi")).resolves.toBeUndefined();
  });

  test("success path is unchanged", async () => {
    const bot = makeBot();
    await expect(bot.notify("hi")).resolves.toBeUndefined();
  });
});

describe("ToolExecutor.tgSendMessage", () => {
  const memoryStub = {} as MemoryDB;
  const routerStub = {} as ModelRouter;

  test("returns error when botNotify throws", async () => {
    const exec = new ToolExecutor(memoryStub, routerStub);
    exec.setBotNotify(async () => {
      throw new Error("telegram 500");
    });
    const r = await exec.tgSendMessage("hi");
    expect(r.kind).toBe("error");
    expect(r.error.message).toBe("telegram 500");
  });

  test("returns success when botNotify resolves", async () => {
    const exec = new ToolExecutor(memoryStub, routerStub);
    exec.setBotNotify(async () => {});
    const r = await exec.tgSendMessage("hi");
    expect(r.kind).toBe("success");
    expect(r.data).toBe("Message sent to owner");
  });

  test("returns not-configured error when botNotify unset", async () => {
    const exec = new ToolExecutor(memoryStub, routerStub);
    const r = await exec.tgSendMessage("hi");
    expect(r.kind).toBe("error");
    expect(r.error.message).toContain("not configured");
  });
});
