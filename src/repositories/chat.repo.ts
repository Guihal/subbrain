/**
 * ChatRepository — PR 27 (LAYER-5).
 *
 * Owns `chats`, `chat_messages`, `tg_excluded_chats`. Wrapper over
 * `ChatsTable` — zero added behaviour, just the narrower surface services
 * see (routes still reach via `MemoryDB` facade).
 */
import { Database } from "bun:sqlite";
import { ChatsTable } from "../db/tables/chats";
import type { ChatRow, ChatMessageRow, TgExcludedChatRow } from "../db/types";

export class ChatRepository {
  private readonly chats: ChatsTable;

  constructor(db: Database) {
    this.chats = new ChatsTable(db);
  }

  // ─── Chats ─────────────────────────────────────────────────
  createChat = (id: string, title: string, model: string, source?: string) =>
    this.chats.createChat(id, title, model, source);
  getChat = (id: string): ChatRow | null => this.chats.getChat(id);
  listChats = (limit?: number, source?: string): ChatRow[] =>
    this.chats.listChats(limit, source);
  updateChatTitle = (id: string, title: string) => this.chats.updateChatTitle(id, title);
  updateChatModel = (id: string, model: string) => this.chats.updateChatModel(id, model);
  updateChatTimestamp = (id: string) => this.chats.updateChatTimestamp(id);
  deleteChat = (id: string) => this.chats.deleteChat(id);

  // ─── Chat Messages ─────────────────────────────────────────
  appendChatMessage = (
    chatId: string,
    role: string,
    content: string,
    opts?: { reasoning?: string; model?: string; requestId?: string },
  ) => this.chats.appendChatMessage(chatId, role, content, opts);
  getChatMessages = (chatId: string): ChatMessageRow[] => this.chats.getChatMessages(chatId);

  // ─── Telegram exclusions (live on chats table) ─────────────
  getExcludedTgChats = (): TgExcludedChatRow[] => this.chats.getExcludedTgChats();
  getExcludedTgChatIds = (): Set<string> => this.chats.getExcludedTgChatIds();
  excludeTgChat = (chatId: string, chatTitle: string, reason?: string) =>
    this.chats.excludeTgChat(chatId, chatTitle, reason);
  includeTgChat = (chatId: string) => this.chats.includeTgChat(chatId);
}
