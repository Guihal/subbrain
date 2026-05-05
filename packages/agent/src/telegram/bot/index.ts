import type { MemoryDB } from "@subbrain/core/db";
import { logger } from "@subbrain/core/lib/logger";
import { Bot, webhookCallback } from "grammy";
import type { ModelRouter } from "@subbrain/core/lib/model-router";
import type { AgentPipeline } from "../../pipeline";
import { registerCommands } from "./commands";
import { registerMessageHandler } from "./message";
import { createNotifier, type Notifier } from "./notify";
import type { BotState } from "./state";

const log = logger.child("telegram");

export interface TelegramBotConfig {
  token: string;
  ownerChatId: number;
  webhookSecret: string;
  memory: MemoryDB;
  pipeline: AgentPipeline;
  router: ModelRouter;
}

/**
 * Telegram bot — chat with agents + receive notifications.
 * One chat per Telegram dialog, persisted in the same DB as web chats.
 */
export class TelegramBot {
  bot: Bot;
  webhookSecret: string;
  private state: BotState;
  private notifier: Notifier;
  private reportSender: ((text: string) => Promise<void>) | null = null;

  constructor(config: TelegramBotConfig) {
    this.bot = new Bot(config.token);
    this.webhookSecret = config.webhookSecret;

    this.state = {
      ownerChatId: config.ownerChatId,
      memory: config.memory,
      pipeline: config.pipeline,
      router: config.router,
      chatMap: new Map(),
      modelMap: new Map(),
      getModel: (id) => this.state.modelMap.get(id) || "teamlead",
    };

    this.notifier = createNotifier(() => ({
      bot: this.bot,
      ownerChatId: this.state.ownerChatId,
      reportSender: this.reportSender as (text: string) => Promise<void> | null,
    }));

    registerCommands(this.bot, this.state);
    registerMessageHandler(this.bot, this.state);
  }

  setReportSender(fn: (text: string) => Promise<void>): void {
    this.reportSender = fn;
  }

  /** Must be called before handling updates (fetches bot info from Telegram) */
  async init(): Promise<void> {
    await this.bot.init();
    log.info(`Bot @${this.bot.botInfo.username} initialized`);
  }

  // ─── Notifications (delegated) ────────────────────────────
  notify = (text: string) => this.notifier.notify(text);
  notifyOrThrow = (text: string) => this.notifier.notifyOrThrow(text);
  notifyDigest = (digest: string) => this.notifier.notifyDigest(digest);
  notifyAutonomous = (summary: string) => this.notifier.notifyAutonomous(summary);

  // ─── Webhook + lifecycle ──────────────────────────────────

  getWebhookHandler() {
    return webhookCallback(this.bot, "std/http", { secretToken: this.webhookSecret });
  }

  async setWebhook(url: string): Promise<void> {
    await this.bot.api.setWebhook(url, { secret_token: this.webhookSecret });
    log.info(`Webhook set: ${url}`);
  }

  async removeWebhook(): Promise<void> {
    await this.bot.api.deleteWebhook();
    log.info("Webhook removed");
  }

  /** Start long-polling (for local dev without webhook) */
  startPolling(): void {
    this.bot.start({ onStart: () => log.info("Bot polling started") });
  }

  stop(): void {
    this.bot.stop();
  }
}
