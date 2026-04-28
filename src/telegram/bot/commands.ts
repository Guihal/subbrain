import type { Bot } from "grammy";
import { randomUUID } from "crypto";
import { MODEL_MAP } from "../../lib/model-map";
import type { BotState } from "./state";
import { escapeMarkdown } from "./utils";

export function registerCommands(bot: Bot, state: BotState): void {
  // Owner-only middleware
  bot.use(async (ctx, next) => {
    if (ctx.chat?.id !== state.ownerChatId) {
      await ctx.reply("⛔ Доступ запрещён.");
      return;
    }
    await next();
  });

  bot.command("start", (ctx) =>
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

  bot.command("new", async (ctx) => {
    const tgChatId = ctx.chat.id;
    const chatId = randomUUID();
    state.chatMap.set(tgChatId, chatId);
    state.memory.createChat(chatId, "Telegram чат", state.getModel(tgChatId), "telegram");
    await ctx.reply("✅ Новый чат создан. Пиши сообщение.");
  });

  bot.command("model", async (ctx) => {
    const roles = Object.keys(MODEL_MAP);
    const current = state.getModel(ctx.chat.id);
    const text = roles.map((r) => `${r === current ? "▸ " : "  "}\`${r}\``).join("\n");
    await ctx.reply(
      `Текущая роль: \`${current}\`\n\nДля смены: /model <роль>\n\n${text}`,
      { parse_mode: "Markdown" },
    );
    const arg = ctx.match?.trim();
    if (arg && roles.includes(arg)) {
      state.modelMap.set(ctx.chat.id, arg);
      await ctx.reply(`✅ Роль: \`${arg}\``, { parse_mode: "Markdown" });
    }
  });

  bot.command("status", async (ctx) => {
    const stats = state.router.stats;
    await ctx.reply(
      `📊 *Статус*\n` +
        `RPM: ${stats.currentLoad}/${stats.currentLoad + stats.availableSlots}\n` +
        `Очередь: ${stats.queueLength}\n` +
        `Слотов свободно: ${stats.availableSlots}`,
      { parse_mode: "Markdown" },
    );
  });

  bot.command("chats", async (ctx) => {
    const chats = state.memory.listChats(10, "telegram");
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

  bot.command("digest", async (ctx) => {
    const entries = state.memory.searchArchive("daily digest", 1);
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
}
