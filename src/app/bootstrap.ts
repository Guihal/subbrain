import { Elysia } from "elysia";
import { staticPlugin } from "@elysiajs/static";
import { authMiddleware } from "../lib/auth";
import { chatRoute } from "../routes/chat";
import { modelsRoute } from "../routes/models";
import { embeddingsRoute } from "../routes/embeddings";
import { logsRoute } from "../routes/logs";
import { autonomousRoute } from "../routes/autonomous";
import { chatsRoute } from "../routes/chats";
import { memoryRoute } from "../routes/memory";
import { freelanceRoute } from "../routes/freelance";
import { telegramPublicRoute, telegramAdminRoute } from "../routes/telegram";
import { tasksRoute } from "../routes/tasks";
import { mcpRoute, mcpProtocolRoute } from "../mcp";
import { logger } from "../lib/logger";
import { AppError } from "../lib/errors";
import type { AppDeps } from "./deps";
import { NightCycleController } from "./night-cycle-controller";

export function createApp(deps: AppDeps) {
  const {
    memory,
    router,
    tools,
    metrics,
    nightCycle,
    registry,
    pipeline,
    agentLoop,
    telegramBot,
    config,
  } = deps;

  const nightCycleController = new NightCycleController(nightCycle);

  const app = new Elysia()
    .onError(({ code, error, set, path }) => {
      if (error instanceof AppError) {
        set.status = error.status;
        return {
          error: {
            code: error.code,
            message: error.message,
            ...(error.details ?? {}),
          },
        };
      }
      if (code === "VALIDATION") {
        logger.warn(
          "validation",
          `422 on ${path}: ${(error as any)?.message?.slice?.(0, 500) || error}`,
          {
            meta: {
              validator: (error as any)?.validator,
              type: (error as any)?.type,
            },
          } as any,
        );
        set.status = 422;
        return {
          error: {
            message: `Validation error: ${(error as any)?.message?.slice?.(0, 300) || "invalid request body"}`,
            type: "validation_error",
            code: 422,
          },
        };
      }
      set.status = 500;
      logger.error("http", "unhandled", {
        meta: {
          path,
          err: (error as any)?.message,
          stack: (error as any)?.stack,
        },
      } as any);
      return {
        error: { code: "internal_error", message: "internal" },
      };
    })
    .use(staticPlugin({ assets: "public", prefix: "/" }))
    .decorate("memory", memory)
    .decorate("router", router)
    .decorate("tools", tools)
    .decorate("metrics", metrics)
    .decorate("nightCycle", nightCycle)
    // ── Public surface (BEFORE authMiddleware) ─────────────────────────────
    //   /health, /metrics — health/observability, infrastructure-only.
    //   telegramPublicRoute — /telegram/webhook, authed via grammy secret
    //     header; listed in `auth.ts` bypass to allow that single path.
    //   mcpProtocolRoute — carries its own bearer check inside the handler.
    .get("/health", ({ router }) => ({
      status: "ok",
      timestamp: Date.now(),
      rpm: router.stats,
    }))
    .get("/metrics", ({ metrics }) => metrics.snapshot())
    .use(telegramPublicRoute(telegramBot))
    .use(mcpProtocolRoute(registry, tools, config.authToken))
    // ── Protected surface (AFTER authMiddleware) ──────────────────────────
    //   Everything below requires Bearer auth. `/api/token`, `/night-cycle`
    //   and telegramAdminRoute (set/remove webhook) were previously mounted
    //   before the middleware — AUTH-16. Do not move them back.
    .use(authMiddleware(config.authToken))
    .get("/api/token", () => ({ token: config.authToken }))
    .post("/night-cycle", ({ set }) => {
      const r = nightCycleController.trigger("http");
      if (!r.started) set.status = 409;
      return r;
    })
    .get("/night-cycle/status", () => ({
      running: nightCycleController.running,
      startedAt: nightCycleController.startedAt,
      lastResult: nightCycleController.lastResult,
    }))
    .use(telegramAdminRoute(telegramBot))
    .use(chatRoute(router, pipeline, memory))
    .use(modelsRoute(router))
    .use(embeddingsRoute(router))
    .use(logsRoute(memory))
    .use(mcpRoute(registry, tools))
    .use(autonomousRoute(agentLoop, memory))
    .use(chatsRoute(memory))
    .use(memoryRoute(memory))
    .use(freelanceRoute(memory, deps.freelanceScout))
    .use(tasksRoute(memory));

  return { app, nightCycleController } as const;
}
