import type { MemoryDB } from "@subbrain/core/db";
import { Api, type TelegramClient } from "telegram";
import { TG_OP_TIMEOUT_MS, withTimeout } from "./connection";
import type { TgMessage } from "./types";

type Hit = TgMessage & { chatName: string; chatId: string };

function peerToId(peerId: unknown): string {
  const p = peerId as {
    channelId?: { toString(): string };
    chatId?: { toString(): string };
    userId?: { toString(): string };
  };
  return p?.channelId?.toString() || p?.chatId?.toString() || p?.userId?.toString() || "";
}

function resolveChatName(
  result: {
    chats?: { id?: { toString(): string }; title?: string }[];
    users?: { id?: { toString(): string }; firstName?: string }[];
  },
  peerId: string,
): string {
  if (Array.isArray(result.chats)) {
    const chat = result.chats.find((c) => c.id?.toString() === peerId);
    if (chat?.title) return chat.title;
  }
  if (Array.isArray(result.users)) {
    const user = result.users.find((u) => u.id?.toString() === peerId);
    if (user?.firstName) return user.firstName;
  }
  return peerId;
}

export async function searchMessages(
  client: TelegramClient,
  memory: MemoryDB,
  query: string,
  limit = 30,
  chatId?: string,
): Promise<Hit[]> {
  const excluded = memory.getExcludedTgChatIds();
  if (chatId && excluded.has(chatId)) {
    throw new Error(`Chat ${chatId} is excluded from reading`);
  }
  const peer = chatId
    ? await withTimeout(client.getEntity(chatId), TG_OP_TIMEOUT_MS, `getEntity(${chatId})`)
    : undefined;
  const result = await withTimeout(
    client.invoke(
      new Api.messages.SearchGlobal({
        q: query,
        filter: new Api.InputMessagesFilterEmpty(),
        minDate: 0,
        maxDate: 0,
        offsetRate: 0,
        offsetPeer: new Api.InputPeerEmpty(),
        offsetId: 0,
        limit,
        ...(peer ? { peer } : {}),
      }),
    ),
    TG_OP_TIMEOUT_MS,
    "searchMessages",
  );
  const hits: Hit[] = [];
  if (!("messages" in result)) return hits;
  for (const m of result.messages) {
    if (!("message" in m) || !m.message) continue;
    const peerId = peerToId(m.peerId);
    if (excluded.has(peerId)) continue;
    const chatName = resolveChatName(result as Parameters<typeof resolveChatName>[0], peerId);
    hits.push({
      id: m.id,
      sender: chatName,
      text: m.message,
      date: new Date(m.date * 1000).toISOString(),
      chatName,
      chatId: peerId,
    });
  }
  return hits;
}
