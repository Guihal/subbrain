import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions";
import type { MemoryDB } from "../db";
import { logger } from "../lib/logger";

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

/**
 * MTProto userbot — reads user's Telegram chats (except excluded).
 * Runs alongside the bot. Session is persisted as a string in env.
 */
export class Userbot {
  private client: TelegramClient;
  private memory: MemoryDB;
  private monitoredChannels: string[] = [];
  private running = false;
  private connected = false;

  constructor(private config: UserbotConfig) {
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
      phoneNumber: async () => {
        return prompt("Введи номер телефона: ") || "";
      },
      password: async () => {
        return prompt("Введи пароль 2FA (или Enter): ") || "";
      },
      phoneCode: async () => {
        return prompt("Введи код из Telegram: ") || "";
      },
      onError: (err) => logger.error("userbot", `Login error: ${err.message}`),
    });

    const sessionString = this.client.session.save() as unknown as string;
    logger.info(
      "userbot",
      "Logged in. Save this session string to TG_SESSION env.",
    );
    console.log("\n=== SESSION STRING (save to .env as TG_SESSION) ===");
    console.log(sessionString);
    console.log("=== END ===\n");
    return sessionString;
  }

  /** Connect with saved session (no interactive login) */
  async connect(): Promise<void> {
    await this.client.connect();
    const me = await this.client.getMe();
    this.connected = true;
    logger.info(
      "userbot",
      `Connected as ${(me as any).firstName} (@${(me as any).username})`,
    );
  }

  isConnected(): boolean {
    return this.connected;
  }

  // ─── Chat Reading (with exclusions) ────────────────────────

  /** List all dialogs, marking excluded ones */
  async listChats(limit = 100): Promise<TgDialog[]> {
    const excluded = this.memory.getExcludedTgChatIds();
    const dialogs = await this.client.getDialogs({ limit });
    return dialogs.map((d) => {
      const id = d.id?.toString() || "";
      return {
        name: d.title || "Unknown",
        id,
        type: d.isChannel
          ? ("channel" as const)
          : d.isGroup
            ? ("group" as const)
            : ("private" as const),
        unreadCount: d.unreadCount || 0,
        excluded: excluded.has(id),
      };
    });
  }

  /** Read messages from a chat (respects exclusions) */
  async readChat(
    chatId: string,
    limit = 50,
    offsetId?: number,
  ): Promise<TgMessage[]> {
    const excluded = this.memory.getExcludedTgChatIds();
    if (excluded.has(chatId)) {
      throw new Error(`Chat ${chatId} is excluded from reading`);
    }

    const entity = await this.client.getEntity(chatId);
    const messages = await this.client.getMessages(entity, {
      limit,
      ...(offsetId ? { offsetId } : {}),
    });

    return messages
      .filter((m) => m.message)
      .map((m) => ({
        id: m.id,
        sender:
          (m.sender as any)?.firstName || (m.sender as any)?.title || "Unknown",
        text: m.message || "",
        date: new Date(m.date * 1000).toISOString(),
        ...(m.replyTo ? { replyToId: (m.replyTo as any).replyToMsgId } : {}),
      }));
  }

  /** Search messages across all non-excluded chats */
  async searchMessages(
    query: string,
    limit = 30,
    chatId?: string,
  ): Promise<(TgMessage & { chatName: string; chatId: string })[]> {
    const excluded = this.memory.getExcludedTgChatIds();

    if (chatId) {
      if (excluded.has(chatId)) {
        throw new Error(`Chat ${chatId} is excluded from reading`);
      }
    }

    const peer = chatId ? await this.client.getEntity(chatId) : undefined;

    const result = await this.client.invoke(
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
    );

    const messages: (TgMessage & { chatName: string; chatId: string })[] = [];
    if ("messages" in result) {
      for (const m of result.messages) {
        if (!("message" in m) || !m.message) continue;

        const peerId =
          (m.peerId as any)?.channelId?.toString() ||
          (m.peerId as any)?.chatId?.toString() ||
          (m.peerId as any)?.userId?.toString() ||
          "";

        if (excluded.has(peerId)) continue;

        // Resolve chat name
        let chatName = peerId;
        if ("chats" in result) {
          const chat = (result.chats as any[]).find(
            (c: any) => c.id?.toString() === peerId,
          );
          if (chat) chatName = chat.title || chatName;
        }
        if ("users" in result) {
          const user = (result.users as any[]).find(
            (u: any) => u.id?.toString() === peerId,
          );
          if (user) chatName = user.firstName || chatName;
        }

        messages.push({
          id: m.id,
          sender: chatName,
          text: m.message,
          date: new Date(m.date * 1000).toISOString(),
          chatName,
          chatId: peerId,
        });
      }
    }

    return messages;
  }

  // ─── Channel Monitoring ────────────────────────────────────

  /** Set channels to monitor (usernames or IDs) */
  setMonitoredChannels(channels: string[]): void {
    this.monitoredChannels = channels;
    logger.info(
      "userbot",
      `Monitoring ${channels.length} channels: ${channels.join(", ")}`,
    );
  }

  /** Start listening for new messages in monitored channels */
  async startMonitoring(): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.client.addEventHandler(async (event: any) => {
      try {
        if (!event.message) return;
        const msg = event.message;
        const chatId =
          msg.peerId?.channelId?.toString() || msg.peerId?.chatId?.toString();
        if (!chatId) return;

        // Skip excluded chats
        const excluded = this.memory.getExcludedTgChatIds();
        if (excluded.has(chatId)) return;

        // Check if this channel is monitored
        const entity = await this.client.getEntity(msg.peerId);
        const username = (entity as any).username;
        if (
          !this.monitoredChannels.includes(chatId) &&
          !this.monitoredChannels.includes(username)
        ) {
          return;
        }

        const text = msg.message;
        if (!text) return;

        this.memory.appendLog(
          `tg-monitor-${Date.now()}`,
          "telegram",
          "telegram_monitor",
          "channel_message",
          `[${username || chatId}] ${text}`,
        );

        logger.debug(
          "userbot",
          `New message in ${username || chatId}: ${text.slice(0, 100)}...`,
        );
      } catch (err: any) {
        logger.error("userbot", `Event handler error: ${err.message}`);
      }
    });

    logger.info("userbot", "Channel monitoring started");
  }

  async disconnect(): Promise<void> {
    this.running = false;
    this.connected = false;
    await this.client.disconnect();
    logger.info("userbot", "Disconnected");
  }

  getSessionString(): string {
    return this.client.session.save() as unknown as string;
  }
}
