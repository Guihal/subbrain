import { Database } from "bun:sqlite";
import type { TgMessageRow, TgSearchHit } from "../types";
import { sanitizeFtsQuery } from "../../lib/fts-utils";

export interface TgMessageInsert {
  message_id: number;
  chat_id: string;
  chat_name?: string;
  from_name?: string;
  ts: number;
  text: string;
}

export interface TgSearchOpts {
  query: string;
  chatId?: string;
  from?: number;
  to?: number;
  limit?: number;
}

export class TgMessagesTable {
  constructor(public readonly db: Database) {}

  insert(msg: TgMessageInsert): void {
    this.db
      .query(
        "INSERT OR IGNORE INTO tg_messages (message_id, chat_id, chat_name, from_name, ts, text) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        msg.message_id,
        msg.chat_id,
        msg.chat_name ?? "",
        msg.from_name ?? "",
        msg.ts,
        msg.text,
      );
  }

  insertMany(rows: TgMessageInsert[]): number {
    let inserted = 0;
    this.db.transaction(() => {
      for (const r of rows) {
        this.insert(r);
        inserted++;
      }
    })();
    return inserted;
  }

  count(): number {
    const row = this.db
      .query("SELECT COUNT(*) AS c FROM tg_messages")
      .get() as { c: number };
    return row.c;
  }

  search(opts: TgSearchOpts): { items: TgSearchHit[]; total: number } {
    const limit = Math.max(1, Math.min(200, opts.limit ?? 20));
    const sanitized = sanitizeFtsQuery(opts.query);
    if (!sanitized) return { items: [], total: 0 };

    const filters: string[] = ["fts_tg_messages MATCH ?"];
    const params: (string | number)[] = [sanitized];
    if (opts.chatId) {
      filters.push("m.chat_id = ?");
      params.push(opts.chatId);
    }
    if (opts.from !== undefined) {
      filters.push("m.ts >= ?");
      params.push(opts.from);
    }
    if (opts.to !== undefined) {
      filters.push("m.ts <= ?");
      params.push(opts.to);
    }

    const where = filters.join(" AND ");

    const countRow = this.db
      .query(
        `SELECT COUNT(*) AS c FROM fts_tg_messages JOIN tg_messages m ON m.rowid = fts_tg_messages.rowid WHERE ${where}`,
      )
      .get(...params) as { c: number };

    const rows = this.db
      .query(
        `SELECT m.*, fts_tg_messages.rank AS rank
         FROM fts_tg_messages
         JOIN tg_messages m ON m.rowid = fts_tg_messages.rowid
         WHERE ${where}
         ORDER BY rank
         LIMIT ?`,
      )
      .all(...params, limit) as TgSearchHit[];

    return { items: rows, total: countRow.c };
  }

  recentByChat(chatId: string, limit = 50): TgMessageRow[] {
    return this.db
      .query(
        "SELECT * FROM tg_messages WHERE chat_id = ? ORDER BY ts DESC LIMIT ?",
      )
      .all(chatId, limit) as TgMessageRow[];
  }
}
