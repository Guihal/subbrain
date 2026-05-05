import { logger } from "@subbrain/core/lib/logger";
import type { Bot } from "grammy";

const log = logger.child("telegram");

export interface NotifyDeps {
  bot: Bot;
  ownerChatId: number;
  /** Optional RAG-enriched sender. Falls back to raw notify() when absent or fails. */
  reportSender: (text: string) => Promise<void> | null;
}

export interface Notifier {
  notify(text: string): Promise<void>;
  notifyOrThrow(text: string): Promise<void>;
  notifyDigest(digest: string): Promise<void>;
  notifyAutonomous(summary: string): Promise<void>;
}

export function createNotifier(getDeps: () => NotifyDeps): Notifier {
  const send = (text: string) =>
    getDeps().bot.api.sendMessage(getDeps().ownerChatId, text, { parse_mode: "Markdown" });

  /**
   * Fire-and-forget — swallows delivery errors to log. Use for digests / alerts
   * where failure should not bubble up to caller.
   */
  const notify = async (text: string): Promise<void> => {
    try {
      await send(text);
    } catch (err) {
      log.error(`Notify failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /**
   * Strict — rethrows underlying Telegram API error so caller can see delivery
   * failed (used by tg_send_message tool — keeps agent honest).
   */
  const notifyOrThrow = async (text: string): Promise<void> => {
    await send(text);
  };

  const notifyVia = async (text: string): Promise<void> => {
    const sender = getDeps().reportSender;
    if (sender) {
      try {
        await sender(text);
        return;
      } catch (err) {
        log.warn(`reportSender failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await notify(text);
  };

  return {
    notify,
    notifyOrThrow,
    notifyDigest: (digest) => notifyVia(`📋 *Ночной дайджест*\n\n${digest.slice(0, 4000)}`),
    notifyAutonomous: (summary) =>
      notifyVia(`🤖 *Автономный агент завершил работу*\n\n${summary.slice(0, 4000)}`),
  };
}
