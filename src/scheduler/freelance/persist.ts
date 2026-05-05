import { randomUUID } from "node:crypto";
import type { MemoryDB } from "../../db";
import type { TelegramBot } from "../../telegram/bot";
import type { EvaluatedLead, FeedItem } from "./types";

export function isSeen(db: MemoryDB, url: string): boolean {
  return db.existsFreelanceByUrl(url);
}

export async function saveAndAlert(
  deps: { db: MemoryDB; bot: TelegramBot | null; alertChatId: number | null },
  item: FeedItem,
  evaluated: EvaluatedLead,
): Promise<void> {
  const id = `fl-${randomUUID()}`;
  deps.db.transaction(() => {
    deps.db.insertFreelanceLead({
      id,
      url: item.url,
      source: item.source,
      title: item.title,
      budget: item.budget,
      score: evaluated.score,
      reason: evaluated.reason,
    });
  });

  if (deps.bot) {
    const msg = formatAlert(item, evaluated);
    try {
      if (deps.alertChatId === null) {
        await deps.bot.notify(msg);
      } else {
        await sendToChat(deps.bot, deps.alertChatId, msg);
      }
    } catch {
      /* TG delivery best-effort */
    }
  }
}

export function formatAlert(item: FeedItem, ev: EvaluatedLead): string {
  const budget = item.budget ? `${item.budget} RUB` : "?";
  return [`💼 ${item.source} ${budget} | ${ev.score}/10`, item.title, item.url, ev.reason]
    .filter(Boolean)
    .join("\n");
}

async function sendToChat(bot: TelegramBot, chatId: number, text: string): Promise<void> {
  // Use bot.notify if chat matches owner, else raw sendMessage via grammy.
  interface BotInternal {
    ownerChatId?: number;
    bot?: { api: { sendMessage: (c: number, t: string) => Promise<unknown> } };
    notify: (t: string) => Promise<void>;
  }
  const b = bot as unknown as BotInternal;
  if (b.ownerChatId === chatId) {
    await b.notify(text);
    return;
  }
  if (b.bot?.api?.sendMessage) {
    await b.bot.api.sendMessage(chatId, text);
    return;
  }
  await b.notify(text);
}
