/**
 * TgChatPolicyRepository — PR 27+ (LAYER-5).
 *
 * Wraps `tg_chat_policies` table. Zero business logic — SQL only.
 */
import type { Database } from "bun:sqlite";

export type TgChatPolicy = "metadata_only" | "scrubbed" | "full";

export interface TgChatPolicyRow {
  chat_id: number;
  policy: TgChatPolicy;
  updated_at: number;
  updated_by: string | null;
}

export class TgChatPolicyRepository {
  constructor(private readonly db: Database) {}

  upsert(chatId: number, policy: TgChatPolicy, updatedBy?: string): void {
    this.db
      .query(
        `INSERT INTO tg_chat_policies (chat_id, policy, updated_at, updated_by)
         VALUES (?, ?, unixepoch(), ?)
         ON CONFLICT(chat_id) DO UPDATE SET
           policy = excluded.policy,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`,
      )
      .run(chatId, policy, updatedBy ?? null);
  }

  getByChatId(chatId: number): TgChatPolicyRow | null {
    return this.db
      .query("SELECT * FROM tg_chat_policies WHERE chat_id = ?")
      .get(chatId) as TgChatPolicyRow | null;
  }

  listByPolicy(policy: TgChatPolicy): TgChatPolicyRow[] {
    return this.db
      .query("SELECT * FROM tg_chat_policies WHERE policy = ? ORDER BY updated_at DESC")
      .all(policy) as TgChatPolicyRow[];
  }
}
