import type { MemoryDB } from "@subbrain/core/db";
import { logger } from "@subbrain/core/lib/logger";
import type { TelegramClient } from "telegram";

const log = logger.child("userbot");

export function attachMonitor(
  client: TelegramClient,
  memory: MemoryDB,
  monitoredChannels: string[],
): void {
  client.addEventHandler(async (event: { message?: { peerId?: unknown; message?: string } }) => {
    try {
      if (!event.message) return;
      const msg = event.message;
      const p = msg.peerId as
        | { channelId?: { toString(): string }; chatId?: { toString(): string } }
        | undefined;
      const chatId = p?.channelId?.toString() || p?.chatId?.toString();
      if (!chatId) return;

      const excluded = memory.getExcludedTgChatIds();
      if (excluded.has(chatId)) return;

      const entity = await client.getEntity(msg.peerId as Parameters<typeof client.getEntity>[0]);
      const username = (entity as { username?: string }).username;
      if (!monitoredChannels.includes(chatId) && !monitoredChannels.includes(username || "")) {
        return;
      }
      const text = msg.message;
      if (!text) return;
      memory.appendLog(
        `tg-monitor-${Date.now()}`,
        "telegram",
        "telegram_monitor",
        "channel_message",
        `[${username || chatId}] ${text}`,
      );
      log.debug(`New message in ${username || chatId}: ${text.slice(0, 100)}...`);
    } catch (err) {
      log.error(`Event handler error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}
