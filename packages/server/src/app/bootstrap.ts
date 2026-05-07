import { staticPlugin } from "@elysiajs/static";
import { authMiddleware } from "@subbrain/core/lib/auth";
import { AppError } from "@subbrain/core/lib/errors";
import { logger } from "@subbrain/core/lib/logger";
import { MetricsRepository } from "@subbrain/core/repositories/metrics.repo";
import { TaskRepository } from "@subbrain/core/repositories/task.repo";
import { Elysia } from "elysia";
import { mcpProtocolRoute } from "../mcp-transport/mcp-protocol";
import { mcpRoute } from "../mcp-transport/transport";
import { autonomousRoute } from "../routes/autonomous";
import { chatRoute } from "../routes/chat";
import { chatsRoute } from "../routes/chats";
import { embeddingsRoute } from "../routes/embeddings";
import { agentTasksRoute } from "../routes/agent-tasks";
import { backupRoute } from "../routes/backup";
import { freelanceRoute } from "../routes/freelance";
import { logsRoute } from "../routes/logs";
import { memoryRoute } from "../routes/memory";
import { metricsRunsRoute } from "../routes/metrics";
import { modelsRoute } from "../routes/models";
import { tasksRoute } from "../routes/tasks";
import { telegramAdminRoute, telegramPublicRoute } from "../routes/telegram";
import type { AppDeps } from "./deps";
import { NightCycleController } from "./night-cycle-controller";
// setupInternalPlugins: plugins registered in initDeps() via HooksDispatcher
/** M-1: tolerate Elysia's heterogeneous error shapes at one boundary. */
interface ErrorLike {
  message?: string;
  validator?: unknown;
  type?: string;
  stack?: string;
}
function toErrorLike(err: unknown): ErrorLike {
  if (!err || typeof err !== "object") return {};
  const e = err as Record<string, unknown>;
  return {
    message: typeof e.message === "string" ? e.message : undefined,
    validator: e.validator,
    type: typeof e.type === "string" ? e.type : undefined,
    stack: typeof e.stack === "string" ? e.stack : undefined,
  };
}

export function createApp(deps: AppDeps) {
  const {
    memory,
    memoryService,
    router,
    tools,
    metrics,
    nightCycle,
    registry,
    pipeline,
    agentService,
    telegramBot,
    authService,
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
      // M-1: single boundary type-guard instead of 7× (error as any). Elysia
      // throws a few shapes (TypeBox ValueError, native Error, plain {message}).
      const e = toErrorLike(error);
      if (code === "VALIDATION") {
        logger.warn("validation", `422 on ${path}: ${e.message?.slice(0, 500) || String(error)}`, {
          meta: { validator: e.validator, type: e.type },
        });
        set.status = 422;
        return {
          error: {
            message: `Validation error: ${e.message?.slice(0, 300) || "invalid request body"}`,
            type: "validation_error",
            code: 422,
          },
        };
      }
      set.status = 500;
      logger.error("http", "unhandled", {
        meta: { path, err: e.message, stack: e.stack },
      });
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
    .use(authMiddleware(authService))
    .get("/api/token", () => ({ token: authService.getToken() }))
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
    .use(autonomousRoute(agentService, memory))
    .use(chatsRoute(memory))
    .use(memoryRoute(memoryService, memory))
    .use(freelanceRoute(memory, deps.freelanceScout))
    .use(metricsRunsRoute(new MetricsRepository(memory.db)))
    .use(tasksRoute(new TaskRepository(memory)))
    .use(agentTasksRoute(memory.agentTasksRepo))
    .use(backupRoute());

  return { app, nightCycleController } as const;
}
