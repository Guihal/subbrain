import { logger } from "../../lib/logger";
import type { ChatRepository, MemoryRepository } from "../../repositories";
import type { Message } from "../../providers/types";
import type { CompressorMemory } from "../../pipeline/context-compressor";
import type { MemoryService } from "../memory";
import type { ChatMeta } from "./meta";

export function persistUser(
  chatRepo: ChatRepository | undefined,
  meta: ChatMeta,
  model: string,
  messages: Message[],
): void {
  if (!chatRepo || !meta.chatId) return;
  const lastUserMsg = messages.filter((m) => m.role === "user").pop();
  if (!lastUserMsg?.content) return;
  const existing = chatRepo.getChat(meta.chatId);
  if (!existing) {
    chatRepo.createChat(meta.chatId, lastUserMsg.content.slice(0, 80), model, meta.source);
  } else if (existing.model !== model) {
    chatRepo.updateChatModel(meta.chatId, model);
  }
  chatRepo.appendChatMessage(meta.chatId, "user", lastUserMsg.content);
}

export function maybeHydrate(
  chatRepo: ChatRepository | undefined,
  meta: ChatMeta,
  messages: Message[],
): Message[] {
  if (!chatRepo || !meta.chatId) return messages;
  if (messages.some((m) => m.role === "assistant")) return messages;
  const stored = chatRepo.getChatMessages(meta.chatId);
  if (stored.length <= messages.filter((m) => m.role !== "system").length) return messages;
  const systems = messages.filter((m) => m.role === "system");
  const history: Message[] = stored.map((r) => ({ role: r.role as Message["role"], content: r.content }));
  logger.info("chat-service", `hydrated history from chats: ${history.length} msgs`, {
    meta: { chatId: meta.chatId },
  });
  return [...systems, ...history];
}

/**
 * MEM-2 (M-01): pick the strongest available `insertShared` for the
 * compressor. MemoryService → embed-first + transactional. memoryRepo →
 * raw insert without vec (back-compat for older tests). null → drop facts.
 */
export function compressorMemory(
  memoryService: MemoryService | undefined,
  memoryRepo: MemoryRepository | undefined,
): CompressorMemory | null {
  if (memoryService) {
    const svc = memoryService;
    return {
      insertShared: (
        _id: string,
        category: string,
        content: string,
        tags?: string,
        source?: string,
        opts?: {
          confidence?: number | null;
          status?: import("../../db").MemoryStatus;
          kind?: import("../../db").MemoryKind;
        },
      ) => svc.insertShared({
        category,
        content,
        tags: tags ?? "",
        source,
        confidence: opts?.confidence,
        status: opts?.status,
        kind: opts?.kind,
      }),
    };
  }
  return memoryRepo ?? null;
}
