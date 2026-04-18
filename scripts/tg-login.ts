/**
 * One-time script to login to Telegram via MTProto.
 * Saves session string — add it to .env as TG_SESSION.
 *
 * Usage: bun scripts/tg-login.ts
 */
import { Userbot } from "../src/telegram/userbot";
import { MemoryDB } from "../src/db";

const apiId = Number(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH || "";

if (!apiId || !apiHash) {
  console.error("Set TG_API_ID and TG_API_HASH in .env first");
  process.exit(1);
}

const dbPath = process.env.DB_PATH || "data/subbrain.db";
const memory = new MemoryDB(dbPath);

const tunnel = process.env.TG_TUNNEL_HOST
  ? {
      host: process.env.TG_TUNNEL_HOST,
      basePort: Number(process.env.TG_TUNNEL_BASE_PORT) || 19150,
    }
  : undefined;

const userbot = new Userbot({
  apiId,
  apiHash,
  session: "",
  memory,
  tunnel,
});

const session = await userbot.login();
console.log("\nДобавь в .env:");
console.log(`TG_SESSION=${session}`);

await userbot.disconnect();
memory.close();
