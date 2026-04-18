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
  /** MTProto proxy (optional) */
  proxy?: {
    ip: string;
    port: number;
    secret: string;
  };
}

/**
 * MTProto userbot — monitors channels, reads chat history.
 * Runs alongside the bot. Session is persisted as a string in env.
 */
export class Userbot {
  private client: TelegramClient;
  private memory: MemoryDB;
  private monitoredChannels: string[] = [];
  private running = false;

  constructor(private config: UserbotConfig) {
    const session = new StringSession(config.session);

    this.client = new TelegramClient(session, config.apiId, config.apiHash, {
      connectionRetries: 5,
      ...(config.proxy
        ? {
            useWSS: false,
            proxy: {
              ip: config.proxy.ip,
              port: config.proxy.port,
              socksType: undefined,
              MTProxy: true,
              secret: config.proxy.secret,
            },
          }
        : {}),
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
    logger.info(
      "userbot",
      `Connected as ${(me as any).firstName} (@${(me as any).username})`,
    );
  }

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

        // Store in Layer 4 (raw log) for night cycle processing
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

  /** Fetch recent messages from a channel (for backfill) */
  async fetchChannelHistory(
    channel: string,
    limit = 50,
  ): Promise<{ sender: string; text: string; date: Date }[]> {
    const entity = await this.client.getEntity(channel);
    const messages = await this.client.getMessages(entity, { limit });

    return messages
      .filter((m) => m.message)
      .map((m) => ({
        sender: (m.sender as any)?.firstName || "Unknown",
        text: m.message || "",
        date: new Date(m.date * 1000),
      }));
  }

  /** Get list of user's dialogs (chats, groups, channels) */
  async getDialogs(
    limit = 30,
  ): Promise<{ name: string; id: string; type: string }[]> {
    const dialogs = await this.client.getDialogs({ limit });
    return dialogs.map((d) => ({
      name: d.title || "Unknown",
      id: d.id?.toString() || "",
      type: d.isChannel ? "channel" : d.isGroup ? "group" : "private",
    }));
  }

  async disconnect(): Promise<void> {
    this.running = false;
    await this.client.disconnect();
    logger.info("userbot", "Disconnected");
  }

  getSessionString(): string {
    return this.client.session.save() as unknown as string;
  }
}
