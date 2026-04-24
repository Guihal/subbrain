/**
 * TelegramRepository — PR 27 (LAYER-5). Wraps `TgMessagesTable` (FTS index
 * of bot-scraped chat history).
 *
 * Note: `tg_excluded_chats` lives on `ChatRepository` (shares the chats
 * table).
 */
import { Database } from "bun:sqlite";
import {
  TgMessagesTable,
  type TgMessageInsert,
  type TgSearchOpts,
} from "../db/tables/tg-messages";
import type { TgMessageRow, TgSearchHit } from "../db/types";

export class TelegramRepository {
  private readonly tg: TgMessagesTable;

  constructor(db: Database) {
    this.tg = new TgMessagesTable(db);
  }

  insertTgMessage = (msg: TgMessageInsert): void => this.tg.insert(msg);
  insertTgMessages = (rows: TgMessageInsert[]): number => this.tg.insertMany(rows);
  searchTgMessages = (opts: TgSearchOpts): { items: TgSearchHit[]; total: number } =>
    this.tg.search(opts);
  recentTgMessages = (chatId: string, limit?: number): TgMessageRow[] =>
    this.tg.recentByChat(chatId, limit);
  countTgMessages = (): number => this.tg.count();
}
