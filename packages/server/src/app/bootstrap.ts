import { staticPlugin } from "@elysiajs/static";
import { authMiddleware } from "@subbrain/core/lib/auth";
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
import { type AppErrorContext, handleAppError } from "./error-handler";
import { NightCycleController } from "./night-cycle-controller";
// setupInternalPlugins: plugins registered in initDeps() via HooksDispatcher

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

  const nightCycleController = new NightCycleController(nightCycle, config.nightCycle.timeoutMs);

  const app = new Elysia()
    .onError((ctx) => handleAppError(ctx as AppErrorContext))
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
    // ── Protected (AFTER authMiddleware) — AUTH-16. /api/token cold-load:
    //   Caddy upstream injects Bearer for browsers; localhost callers hold
    //   PROXY_AUTH_TOKEN; direct browser hits without Caddy → 401.
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
