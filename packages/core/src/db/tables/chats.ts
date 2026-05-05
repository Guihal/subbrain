import type { Database } from "bun:sqlite";
import type { ChatMessageRow, ChatRow, TgExcludedChatRow } from "../types";

export class ChatsTable {
  constructor(public readonly db: Database) {}

  // ─── Chats ─────────────────────────────────────────────────

  createChat(id: string, title: string, model: string, source: string = "web"): void {
    this.db
      .query("INSERT INTO chats (id, title, model, source) VALUES (?, ?, ?, ?)")
      .run(id, title, model, source);
  }

  getChat(id: string): ChatRow | null {
    return this.db.query("SELECT * FROM chats WHERE id = ?").get(id) as ChatRow | null;
  }

  listChats(limit = 50, source?: string): ChatRow[] {
    if (source) {
      return this.db
        .query("SELECT * FROM chats WHERE source = ? ORDER BY updated_at DESC LIMIT ?")
        .all(source, limit) as ChatRow[];
    }
    return this.db
      .query("SELECT * FROM chats ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as ChatRow[];
  }

  updateChatTitle(id: string, title: string): void {
    this.db
      .query("UPDATE chats SET title = ?, updated_at = unixepoch() WHERE id = ?")
      .run(title, id);
  }

  updateChatModel(id: string, model: string): void {
    this.db
      .query("UPDATE chats SET model = ?, updated_at = unixepoch() WHERE id = ?")
      .run(model, id);
  }

  updateChatTimestamp(id: string): void {
    this.db.query("UPDATE chats SET updated_at = unixepoch() WHERE id = ?").run(id);
  }

  deleteChat(id: string): void {
    this.db.query("DELETE FROM chats WHERE id = ?").run(id);
  }

  // ─── Chat Messages ─────────────────────────────────────────

  appendChatMessage(
    chatId: string,
    role: string,
    content: string,
    opts?: { reasoning?: string; model?: string; requestId?: string },
  ): number {
    const result = this.db
      .query(
        "INSERT INTO chat_messages (chat_id, role, content, reasoning, model, request_id) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        chatId,
        role,
        content,
        opts?.reasoning ?? null,
        opts?.model ?? null,
        opts?.requestId ?? null,
      );
    this.updateChatTimestamp(chatId);
    return Number(result.lastInsertRowid);
  }

  getChatMessages(chatId: string): ChatMessageRow[] {
    return this.db
      .query("SELECT * FROM chat_messages WHERE chat_id = ? ORDER BY id ASC")
      .all(chatId) as ChatMessageRow[];
  }

  // ─── Telegram Chat Exclusions ──────────────────────────────

  getExcludedTgChats(): TgExcludedChatRow[] {
    return this.db
      .query("SELECT * FROM tg_excluded_chats ORDER BY created_at")
      .all() as TgExcludedChatRow[];
  }

  getExcludedTgChatIds(): Set<string> {
    const rows = this.db.query("SELECT chat_id FROM tg_excluded_chats").all() as {
      chat_id: string;
    }[];
    return new Set(rows.map((r) => r.chat_id));
  }

  excludeTgChat(chatId: string, chatTitle: string, reason = "private"): void {
    this.db
      .query(
        "INSERT OR REPLACE INTO tg_excluded_chats (chat_id, chat_title, reason) VALUES (?, ?, ?)",
      )
      .run(chatId, chatTitle, reason);
  }

  includeTgChat(chatId: string): void {
    this.db.query("DELETE FROM tg_excluded_chats WHERE chat_id = ?").run(chatId);
  }
}
