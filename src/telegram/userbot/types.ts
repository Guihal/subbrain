import type { MemoryDB } from "../../db";

export interface UserbotConfig {
  apiId: number;
  apiHash: string;
  /** Saved session string. Empty string for first login. */
  session: string;
  memory: MemoryDB;
}

export interface TgDialog {
  name: string;
  id: string;
  type: "channel" | "group" | "private";
  unreadCount: number;
  excluded: boolean;
}

export interface TgMessage {
  id: number;
  sender: string;
  text: string;
  date: string; // ISO
  replyToId?: number;
}
