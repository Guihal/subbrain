import type { Context } from "grammy";
import type { MemoryDB } from "../../db";
import type { Message } from "../../providers/types";

export function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}

export async function sendLongMessage(ctx: Context, text: string): Promise<void> {
  const MAX = 4096;
  if (text.length <= MAX) {
    await ctx.reply(text);
    return;
  }
  // Split at last newline before limit (best-effort: just slice in MAX-sized chunks).
  for (let i = 0; i < text.length; i += MAX) {
    const chunk = text.slice(i, i + MAX);
    await ctx.reply(chunk);
  }
}

export function buildMessages(memory: MemoryDB, chatId: string): Message[] {
  const rows = memory.getChatMessages(chatId);
  // Keep last 20 messages to stay within context.
  const recent = rows.slice(-20);
  return recent.map((r) => ({
    role: r.role as "user" | "assistant" | "system",
    content: r.content,
  }));
}
