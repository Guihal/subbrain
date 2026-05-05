import { randomUUID } from "node:crypto";
import { logger } from "@subbrain/core/lib/logger";
import type { Bot } from "grammy";
import type { BotState } from "./state";
import { buildMessages, sendLongMessage } from "./utils";

const log = logger.child("telegram");

function findOrCreateChat(
  state: BotState,
  tgChatId: number,
  firstMessage: string,
  model: string,
): string {
  // Stub for future per-TG-chat persistence; for now always create a new subbrain chat.
  const chatId = randomUUID();
  const title = firstMessage.slice(0, 80);
  state.memory.createChat(chatId, title, model, "telegram");
  state.chatMap.set(tgChatId, chatId);
  return chatId;
}

export function registerMessageHandler(bot: Bot, state: BotState): void {
  bot.on("message:text", async (ctx) => {
    const tgChatId = ctx.chat.id;
    const text = ctx.message.text;
    const model = state.getModel(tgChatId);

    let chatId = state.chatMap.get(tgChatId);
    if (!chatId) chatId = findOrCreateChat(state, tgChatId, text, model);

    state.memory.appendChatMessage(chatId, "user", text);
    await ctx.replyWithChatAction("typing");

    try {
      const messages = buildMessages(state.memory, chatId);
      const result = await state.pipeline.execute({
        model,
        messages,
        stream: false,
        temperature: 0.7,
      });
      const content = result.response?.choices?.[0]?.message?.content || "_(пустой ответ)_";
      state.memory.appendChatMessage(chatId, "assistant", content, {
        model,
        requestId: result.requestId,
      });
      await sendLongMessage(ctx, content);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`Pipeline error: ${msg}`);
      await ctx.reply(`❌ Ошибка: ${msg}`);
    }
  });
}
