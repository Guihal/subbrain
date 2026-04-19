import { Elysia } from "elysia";
import type { TelegramBot } from "../telegram";
import { logger } from "../lib/logger";

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

  route.post("/telegram/webhook", async ({ body, request }) => {
    try {
      // Verify secret token from Telegram
      const secret = request.headers.get("x-telegram-bot-api-secret-token");
      if (bot.webhookSecret && secret !== bot.webhookSecret) {
        logger.warn("telegram", "Webhook: invalid secret token");
        return new Response("Unauthorized", { status: 401 });
      }

      // Process update directly through Grammy bot
      await bot.bot.handleUpdate(body as any);
      return new Response("OK", { status: 200 });
    } catch (err) {
      logger.error(
        "telegram",
        `Webhook error: ${err instanceof Error ? err.message : String(err)}`,
      );
      return new Response("Internal error", { status: 500 });
    }
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
