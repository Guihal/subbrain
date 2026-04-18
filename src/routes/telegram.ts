import { Elysia } from "elysia";
import type { TelegramBot } from "../telegram";

/**
 * Telegram webhook route.
 * POST /telegram/webhook — receives updates from Telegram Bot API.
 * Excluded from Bearer auth (validated via webhook secret_token header).
 */
export function telegramRoute(bot: TelegramBot | null) {
  const route = new Elysia();

  if (!bot) {
    // Bot not configured — return 404 on webhook
    route.post(
      "/telegram/webhook",
      () => new Response("Bot not configured", { status: 404 }),
    );
    return route;
  }

  const handler = bot.getWebhookHandler();

  route.post("/telegram/webhook", async ({ request }) => {
    return handler(request);
  });

  // Admin: set/remove webhook
  route.post("/telegram/set-webhook", async ({ body }) => {
    const { url } = body as { url: string };
    await bot.setWebhook(url);
    return { ok: true, url };
  });

  route.post("/telegram/remove-webhook", async () => {
    await bot.removeWebhook();
    return { ok: true };
  });

  return route;
}
