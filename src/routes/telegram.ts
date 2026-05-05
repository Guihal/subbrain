import { Elysia } from "elysia";
import { logger } from "../lib/logger";
import type { TelegramBot } from "../telegram";

/**
 * Public Telegram webhook route — mounted BEFORE authMiddleware.
 * POST /telegram/webhook — receives updates from Telegram Bot API;
 * authenticated via the `x-telegram-bot-api-secret-token` header.
 *
 * Admin endpoints (set/remove webhook) live in `telegramAdminRoute`
 * and MUST be mounted AFTER authMiddleware.
 */
export function telegramPublicRoute(bot: TelegramBot | null) {
  const route = new Elysia();

  if (!bot) {
    route.post("/telegram/webhook", () => new Response("Bot not configured", { status: 404 }));
    return route;
  }

  route.post("/telegram/webhook", async ({ body, request }) => {
    try {
      const secret = request.headers.get("x-telegram-bot-api-secret-token");
      if (bot.webhookSecret && secret !== bot.webhookSecret) {
        logger.warn("telegram", "Webhook: invalid secret token");
        return new Response("Unauthorized", { status: 401 });
      }

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

  return route;
}

/**
 * Protected admin surface — mount AFTER authMiddleware. Anyone able to call
 * these can repoint the bot, so bearer auth is mandatory.
 */
export function telegramAdminRoute(bot: TelegramBot | null) {
  const route = new Elysia();
  if (!bot) return route;

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
