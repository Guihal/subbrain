/**
 * One-off backfill: pull last N messages per non-excluded TG chat via MTProto
 * userbot and push them into the local FTS index (`tg_messages`).
 *
 * Usage:
 *   bun run scripts/tg-reindex.ts           # default: 200 msgs per chat
 *   TG_REINDEX_PER_CHAT=500 bun run scripts/tg-reindex.ts
 *
 * Requires: TG_API_ID, TG_API_HASH, TG_SESSION, DB_PATH (optional).
 */

import { Userbot } from "@subbrain/agent/telegram";
import { MemoryDB } from "@subbrain/core/db";
import { logger } from "@subbrain/core/lib/logger";

const log = logger.child("tg-reindex");

async function main(): Promise<void> {
  const apiId = Number(process.env.TG_API_ID);
  const apiHash = process.env.TG_API_HASH || "";
  const session = process.env.TG_SESSION || "";
  if (!apiId || !apiHash || !session) {
    console.error("Missing TG_API_ID / TG_API_HASH / TG_SESSION");
    process.exit(1);
  }
  const dbPath = process.env.DB_PATH || "data/subbrain.db";
  const perChat = Math.max(1, Math.min(2000, Number(process.env.TG_REINDEX_PER_CHAT) || 200));

  const memory = new MemoryDB(dbPath);
  const userbot = new Userbot({ apiId, apiHash, session, memory });
  await userbot.connect();

  const dialogs = await userbot.listChats(500);
  const active = dialogs.filter((d) => !d.excluded);
  log.info(`Backfilling ${active.length}/${dialogs.length} chats (${perChat} msgs each)`);

  let total = 0;
  for (const d of active) {
    try {
      const msgs = await userbot.readChat(d.id, perChat);
      const rows = msgs
        .filter((m) => m.text)
        .map((m) => ({
          message_id: m.id,
          chat_id: d.id,
          chat_name: d.name,
          from_name: m.sender,
          ts: Math.floor(new Date(m.date).getTime() / 1000),
          text: m.text,
        }));
      const n = memory.insertTgMessages(rows);
      total += n;
      log.info(`  ${d.name} (${d.id}): +${n}`);
    } catch (err) {
      log.warn(`  ${d.name} (${d.id}) failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  log.info(`Done. Inserted ${total} messages. tg_messages total=${memory.countTgMessages()}`);
  await userbot.disconnect();
  memory.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
