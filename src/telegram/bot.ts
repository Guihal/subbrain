import { Bot, webhookCallback, type Context } from "grammy";
import { randomUUID } from "crypto";
import type { MemoryDB } from "../db";
import type { AgentPipeline } from "../pipeline";
import type { ModelRouter } from "../lib/model-router";
import type { Message } from "../providers/types";
import { logger } from "../lib/logger";

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
  private ownerChatId: number;
  private memory: MemoryDB;
  private pipeline: AgentPipeline;
  private router: ModelRouter;
  private webhookSecret: string;
  /** Map Telegram chat_id → subbrain chat UUID */
  private chatMap = new Map<number, string>();
  /** Current model per Telegram chat */
  private modelMap = new Map<number, string>();

  constructor(config: TelegramBotConfig) {
    this.bot = new Bot(config.token);
    this.ownerChatId = config.ownerChatId;
    this.memory = config.memory;
    this.pipeline = config.pipeline;
    this.router = config.router;
    this.webhookSecret = config.webhookSecret;

    this.setupHandlers();
  }

  // ─── Handlers ─────────────────────────────────────────────

  private setupHandlers() {
    // Only allow owner
    this.bot.use(async (ctx, next) => {
      if (ctx.chat?.id !== this.ownerChatId) {
        await ctx.reply("⛔ Доступ запрещён.");
        return;
      }
      await next();
    });

    this.bot.command("start", (ctx) =>
      ctx.reply(
        "🧠 *Subbrain* — Цифровая команда\n\n" +
          "Команды:\n" +
          "/new — Новый чат\n" +
          "/model — Выбрать модель/роль\n" +
          "/status — Статус системы\n" +
          "/chats — Список чатов\n" +
          "/digest — Последний дайджест\n\n" +
          "Просто пиши сообщение — я отвечу через пайплайн.",
        { parse_mode: "Markdown" },
      ),
    );

    this.bot.command("new", async (ctx) => {
      const tgChatId = ctx.chat.id;
      const chatId = randomUUID();
      this.chatMap.set(tgChatId, chatId);
      this.memory.createChat(
        chatId,
        "Telegram чат",
        this.getModel(tgChatId),
        "telegram",
      );
      await ctx.reply("✅ Новый чат создан. Пиши сообщение.");
    });

    this.bot.command("model", async (ctx) => {
      const roles = ["teamlead", "coder", "critic", "generalist"];
      const current = this.getModel(ctx.chat.id);
      const text = roles
        .map((r) => `${r === current ? "▸ " : "  "}\`${r}\``)
        .join("\n");
      await ctx.reply(
        `Текущая роль: \`${current}\`\n\nДля смены: /model <роль>\n\n${text}`,
        { parse_mode: "Markdown" },
      );

      const arg = ctx.match?.trim();
      if (arg && roles.includes(arg)) {
        this.modelMap.set(ctx.chat.id, arg);
        await ctx.reply(`✅ Роль: \`${arg}\``, { parse_mode: "Markdown" });
      }
    });

    this.bot.command("status", async (ctx) => {
      const stats = this.router.stats;
      await ctx.reply(
        `📊 *Статус*\n` +
          `RPM: ${stats.currentLoad}/${stats.currentLoad + stats.availableSlots}\n` +
          `Очередь: ${stats.queueLength}\n` +
          `Слотов свободно: ${stats.availableSlots}`,
        { parse_mode: "Markdown" },
      );
    });

    this.bot.command("chats", async (ctx) => {
      const chats = this.memory.listChats(10, "telegram");
      if (!chats.length) {
        await ctx.reply("Нет чатов. /new для создания.");
        return;
      }
      const text = chats
        .map(
          (c, i) =>
            `${i + 1}. *${escapeMarkdown(c.title)}*\n   _${new Date(c.updated_at * 1000).toLocaleString("ru-RU")}_`,
        )
        .join("\n");
      await ctx.reply(text, { parse_mode: "Markdown" });
    });

    this.bot.command("digest", async (ctx) => {
      // Send last compressed knowledge from Layer 3
      const entries = this.memory.searchArchive("daily digest", 1);
      if (!entries.length) {
        await ctx.reply("Дайджестов пока нет.");
        return;
      }
      const e = entries[0];
      await ctx.reply(
        `📋 *Дайджест* (${new Date(e.created_at * 1000).toLocaleDateString("ru-RU")})\n\n${e.snippet.slice(0, 4000)}`,
        { parse_mode: "Markdown" },
      );
    });

    // ─── Text messages → Agent Pipeline ─────────────────────
    this.bot.on("message:text", async (ctx) => {
      const tgChatId = ctx.chat.id;
      const text = ctx.message.text;
      const model = this.getModel(tgChatId);

      // Ensure chat exists
      let chatId = this.chatMap.get(tgChatId);
      if (!chatId) {
        chatId = this.findOrCreateChat(tgChatId, text, model);
      }

      // Save user message
      this.memory.appendChatMessage(chatId, "user", text);

      // Show "typing" while processing
      await ctx.replyWithChatAction("typing");

      try {
        const messages: Message[] = this.buildMessages(chatId);

        const result = await this.pipeline.execute({
          model,
          messages,
          stream: false,
          temperature: 0.7,
        });

        const content =
          result.response?.choices?.[0]?.message?.content || "_(пустой ответ)_";

        // Save assistant message
        this.memory.appendChatMessage(chatId, "assistant", content, {
          model,
          requestId: result.requestId,
        });

        // Telegram has 4096 char limit — split if needed
        await sendLongMessage(ctx, content);
      } catch (err: any) {
        logger.error("telegram", `Pipeline error: ${err.message}`);
        await ctx.reply(`❌ Ошибка: ${err.message}`);
      }
    });
  }

  // ─── Helpers ──────────────────────────────────────────────

  private getModel(tgChatId: number): string {
    return this.modelMap.get(tgChatId) || "teamlead";
  }

  private findOrCreateChat(
    tgChatId: number,
    firstMessage: string,
    model: string,
  ): string {
    // Try to find existing Telegram chat
    const existing = this.memory.listChats(1, "telegram");
    // Check if any recent chat was from this TG chat (by convention, most recent)
    // For simplicity, always create a new one
    const chatId = randomUUID();
    const title = firstMessage.slice(0, 80);
    this.memory.createChat(chatId, title, model, "telegram");
    this.chatMap.set(tgChatId, chatId);
    return chatId;
  }

  private buildMessages(chatId: string): Message[] {
    const rows = this.memory.getChatMessages(chatId);
    // Keep last 20 messages to stay within context
    const recent = rows.slice(-20);
    return recent.map((r) => ({
      role: r.role as "user" | "assistant" | "system",
      content: r.content,
    }));
  }

  // ─── Notifications (outbound) ─────────────────────────────

  async notify(text: string): Promise<void> {
    try {
      await this.bot.api.sendMessage(this.ownerChatId, text, {
        parse_mode: "Markdown",
      });
    } catch (err: any) {
      logger.error("telegram", `Notify failed: ${err.message}`);
    }
  }

  async notifyDigest(digest: string): Promise<void> {
    await this.notify(`📋 *Ночной дайджест*\n\n${digest.slice(0, 4000)}`);
  }

  async notifyAutonomous(summary: string): Promise<void> {
    await this.notify(
      `🤖 *Автономный агент завершил работу*\n\n${summary.slice(0, 4000)}`,
    );
  }

  // ─── Webhook handler for Elysia ──────────────────────────

  getWebhookHandler() {
    return webhookCallback(this.bot, "std/http", {
      secretToken: this.webhookSecret,
    });
  }

  async setWebhook(url: string): Promise<void> {
    await this.bot.api.setWebhook(url, {
      secret_token: this.webhookSecret,
    });
    logger.info("telegram", `Webhook set: ${url}`);
  }

  async removeWebhook(): Promise<void> {
    await this.bot.api.deleteWebhook();
    logger.info("telegram", "Webhook removed");
  }

  /** Start long-polling (for local dev without webhook) */
  startPolling(): void {
    this.bot.start({
      onStart: () => logger.info("telegram", "Bot polling started"),
    });
  }

  stop(): void {
    this.bot.stop();
  }
}

// ─── Utils ──────────────────────────────────────────────────

function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}

async function sendLongMessage(ctx: Context, text: string): Promise<void> {
  const MAX = 4096;
  if (text.length <= MAX) {
    await ctx.reply(text);
    return;
  }
  // Split at last newline before limit
  for (let i = 0; i < text.length; i += MAX) {
    const chunk = text.slice(i, i + MAX);
    await ctx.reply(chunk);
  }
}
