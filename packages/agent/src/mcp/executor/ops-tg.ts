import * as tg from "../telegram-tools";
import type { ToolResultV2 } from "../types";
import type { ExecutorState } from "./types";

/**
 * Send a message to the owner via Telegram bot.
 *
 * Relies on `botNotify` being the throwing variant (`notifyOrThrow`) so we
 * can surface real delivery failures — `notify` (fire-and-forget) would
 * resolve `void` even on HTTP 500, masking the error.
 */
export async function tgSendMessage(s: ExecutorState, text: string): Promise<ToolResultV2> {
  if (!s.botNotify) {
    return { kind: "error", error: { code: "unknown", message: "Telegram bot not configured" } };
  }
  try {
    await s.botNotify(text);
    return { kind: "success", data: "Message sent to owner" };
  } catch (err) {
    return {
      kind: "error",
      error: { code: "unknown", message: err instanceof Error ? err.message : String(err) },
    };
  }
}

export async function tgListChats(s: ExecutorState, limit = 100): Promise<ToolResultV2> {
  return tg.tgListChats(s.userbot, limit);
}

export async function tgReadChat(
  s: ExecutorState,
  chatId: string,
  limit = 50,
  offsetId?: number,
): Promise<ToolResultV2> {
  return tg.tgReadChat(s.userbot, chatId, limit, offsetId);
}

export async function tgSearchMessages(
  s: ExecutorState,
  query: string,
  limit = 30,
  chatId?: string,
): Promise<ToolResultV2> {
  return tg.tgSearchMessages(s.userbot, query, limit, chatId);
}

export function tgExcludeChat(
  s: ExecutorState,
  chatId: string,
  chatTitle: string,
  reason = "private",
): ToolResultV2 {
  return tg.tgExcludeChat(s.memory, chatId, chatTitle, reason);
}

export function tgIncludeChat(s: ExecutorState, chatId: string): ToolResultV2 {
  return tg.tgIncludeChat(s.memory, chatId);
}

export function tgListExcluded(s: ExecutorState): ToolResultV2 {
  return tg.tgListExcluded(s.memory);
}

export function tgSetChatPolicy(
  s: ExecutorState,
  chatId: string,
  policy: "full" | "scrubbed" | "metadata_only",
  updatedBy?: string,
): ToolResultV2 {
  return tg.tgSetChatPolicy(s.memory, chatId, policy, updatedBy);
}

/** FTS5 search over locally indexed TG messages. */
export function tgFtsSearch(
  s: ExecutorState,
  query: string,
  chatId?: string,
  from?: string,
  to?: string,
  limit?: number,
): ToolResultV2 {
  try {
    const fromTs = from ? Math.floor(Date.parse(from) / 1000) : undefined;
    const toTs = to ? Math.floor(Date.parse(to) / 1000) : undefined;
    if ((from && Number.isNaN(fromTs)) || (to && Number.isNaN(toTs))) {
      return { kind: "error", error: { code: "unknown", message: "Invalid from/to ISO date" } };
    }
    const opts: import("@subbrain/core/db").TgSearchOpts = { query };
    if (chatId) opts.chatId = chatId;
    if (fromTs !== undefined) opts.from = fromTs;
    if (toTs !== undefined) opts.to = toTs;
    if (limit !== undefined) opts.limit = limit;
    const { items, total } = s.memory.searchTgMessages(opts);
    return {
      kind: "success",
      data: {
        items: items.map((h) => ({
          ts: h.ts,
          chat: h.chat_name,
          chat_id: h.chat_id,
          from: h.from_name,
          text: h.text,
          message_id: h.message_id,
        })),
        total,
      },
    };
  } catch (err) {
    return {
      kind: "error",
      error: { code: "unknown", message: err instanceof Error ? err.message : String(err) },
    };
  }
}
