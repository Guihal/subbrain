import type { MemoryDB } from "@subbrain/core/db";
import { logger } from "@subbrain/core/lib/logger";
import type { TelegramClient } from "telegram";

const log = logger.child("userbot");

/**
 * Disjoint-by-design contract with `TelegramPoller` (bug-5):
 * - This monitor writes Layer-4 rows with role="channel_message" for realtime
 *   events on `monitoredChannels`. Each row is keyed by a unique
 *   `tg-monitor-${Date.now()}` request_id (no external_message_id stored).
 * - `TelegramPoller.runPoll` reads inbox via injected `readInbox` and writes
 *   ONLY Layer-1 focus KV (`tasks.state`, `tg.poller.last_id`). It never
 *   calls `appendLog` and never emits role="channel_message" rows.
 *
 * Therefore even if both subsystems target the same chat_id, their write
 * surfaces are orthogonal — no duplicate raw_log rows are produced. See
 * `tests/tg-poller-userbot-disjoint.test.ts`.
 */
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
