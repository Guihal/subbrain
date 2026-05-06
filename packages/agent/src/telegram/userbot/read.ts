import type { MemoryDB } from "@subbrain/core/db";
import type { TelegramClient } from "telegram";
import { TG_OP_TIMEOUT_MS, withTimeout } from "./connection";
import type { TgDialog, TgMessage } from "./types";

export async function listChats(
  client: TelegramClient,
  memory: MemoryDB,
  limit = 100,
): Promise<TgDialog[]> {
  const excluded = memory.getExcludedTgChatIds();
  const policies = new Map(
    memory.listKnownTgChats().map((r) => [String(r.chat_id), r.policy]),
  );
  const dialogs = await withTimeout(client.getDialogs({ limit }), TG_OP_TIMEOUT_MS, "listChats");
  return dialogs.map((d) => {
    const id = d.id?.toString() || "";
    return {
      name: d.title || "Unknown",
      id,
      type: d.isChannel ? "channel" : d.isGroup ? "group" : "private",
      unreadCount: d.unreadCount || 0,
      excluded: excluded.has(id),
      policy: policies.get(id) ?? "metadata_only",
    };
  });
}

export async function readChat(
  client: TelegramClient,
  memory: MemoryDB,
  chatId: string,
  limit = 50,
  offsetId?: number,
): Promise<TgMessage[]> {
  const excluded = memory.getExcludedTgChatIds();
  if (excluded.has(chatId)) {
    throw new Error(`Chat ${chatId} is excluded from reading`);
  }
  const entity = await withTimeout(
    client.getEntity(chatId),
    TG_OP_TIMEOUT_MS,
    `getEntity(${chatId})`,
  );
  const messages = await withTimeout(
    client.getMessages(entity, { limit, ...(offsetId ? { offsetId } : {}) }),
    TG_OP_TIMEOUT_MS,
    `getMessages(${chatId})`,
  );
  return messages
    .filter((m) => m.message)
    .map((m) => ({
      id: m.id,
      sender:
        (m.sender as { firstName?: string; title?: string } | null)?.firstName ||
        (m.sender as { firstName?: string; title?: string } | null)?.title ||
        "Unknown",
      text: m.message || "",
      date: new Date(m.date * 1000).toISOString(),
      ...(m.replyTo ? { replyToId: (m.replyTo as { replyToMsgId?: number }).replyToMsgId } : {}),
    }));
}
