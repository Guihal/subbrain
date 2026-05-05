import type { MemoryDB } from "@subbrain/core/db";
import { logger } from "@subbrain/core/lib/logger";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { ensureConnected as connect } from "./connection";
import { attachMonitor } from "./monitor";
import { listChats, readChat } from "./read";
import { searchMessages } from "./search";
import type { TgDialog, TgMessage, UserbotConfig } from "./types";

export type { TgDialog, TgMessage, UserbotConfig } from "./types";

const log = logger.child("userbot");

/**
 * MTProto userbot — reads user's Telegram chats (except excluded).
 * Runs alongside the bot. Session is persisted as a string in env.
 */
export class Userbot {
  private client: TelegramClient;
  private memory: MemoryDB;
  private monitoredChannels: string[] = [];
  private running = false;
  private connState = { connected: false };

  constructor(config: UserbotConfig) {
    const session = new StringSession(config.session);
    this.client = new TelegramClient(session, config.apiId, config.apiHash, {
      connectionRetries: 5,
      useWSS: false,
    });
    this.memory = config.memory;
  }

  /** Interactive login (run once locally, save session string) */
  async login(): Promise<string> {
    await this.client.start({
      phoneNumber: async () => prompt("Введи номер телефона: ") || "",
      password: async () => prompt("Введи пароль 2FA (или Enter): ") || "",
      phoneCode: async () => prompt("Введи код из Telegram: ") || "",
      onError: (err) => log.error(`Login error: ${err.message}`),
    });
    const sessionString = this.client.session.save() as unknown as string;
    log.info("Logged in. Save this session string to TG_SESSION env.");
    return sessionString;
  }

  /** Connect with saved session (no interactive login) */
  async connect(): Promise<void> {
    await this.client.connect();
    const me = (await this.client.getMe()) as { firstName?: string; username?: string };
    this.connState.connected = true;
    log.info(`Connected as ${me.firstName} (@${me.username})`);
  }

  isConnected(): boolean {
    return this.connState.connected;
  }

  private async ensure(): Promise<void> {
    return connect(this.client, this.connState);
  }

  // ─── Chat reading (delegated) ─────────────────────────────
  async listChats(limit = 100): Promise<TgDialog[]> {
    await this.ensure();
    return listChats(this.client, this.memory, limit);
  }

  async readChat(chatId: string, limit = 50, offsetId?: number): Promise<TgMessage[]> {
    await this.ensure();
    return readChat(this.client, this.memory, chatId, limit, offsetId);
  }

  async searchMessages(query: string, limit = 30, chatId?: string) {
    await this.ensure();
    return searchMessages(this.client, this.memory, query, limit, chatId);
  }

  // ─── Channel monitoring ───────────────────────────────────
  setMonitoredChannels(channels: string[]): void {
    this.monitoredChannels = channels;
    log.info(`Monitoring ${channels.length} channels: ${channels.join(", ")}`);
  }

  async startMonitoring(): Promise<void> {
    if (this.running) return;
    this.running = true;
    attachMonitor(this.client, this.memory, this.monitoredChannels);
    log.info("Channel monitoring started");
  }

  async disconnect(): Promise<void> {
    this.running = false;
    this.connState.connected = false;
    await this.client.disconnect();
    log.info("Disconnected");
  }

  getSessionString(): string {
    return this.client.session.save() as unknown as string;
  }
}
