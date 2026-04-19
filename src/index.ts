import { Elysia } from "elysia";
import { staticPlugin } from "@elysiajs/static";
import { createProviders } from "./providers";
import { authMiddleware } from "./lib/auth";
import { ModelRouter } from "./lib/model-router";
import { chatRoute } from "./routes/chat";
import { modelsRoute } from "./routes/models";
import { embeddingsRoute } from "./routes/embeddings";
import { logsRoute } from "./routes/logs";
import { autonomousRoute } from "./routes/autonomous";
import { chatsRoute } from "./routes/chats";
import { telegramRoute } from "./routes/telegram";
import { MemoryDB } from "./db";
import { ToolExecutor, mcpRoute } from "./mcp";
import { RAGPipeline } from "./rag";
import {
  AgentPipeline,
  ArbitrationRoom,
  NightCycle,
  AgentLoop,
} from "./pipeline";
import { TelegramBot, Userbot } from "./telegram";
import { Metrics } from "./lib/metrics";
import { logger } from "./lib/logger";

const port = Number(process.env.PROXY_PORT) || 4000;
const authToken = process.env.PROXY_AUTH_TOKEN;
const dbPath = process.env.DB_PATH || "data/subbrain.db";
const autonomousEnabled =
  process.env.AUTONOMOUS_ENABLED === "true" ||
  (process.env.AUTONOMOUS_ENABLED !== "false" &&
    process.env.NODE_ENV === "production");
const autonomousIntervalMinutes = Math.max(
  1,
  Number(process.env.AUTONOMOUS_INTERVAL_MINUTES) || 15,
);
const autonomousStartupDelayMs = Math.max(
  0,
  Number(process.env.AUTONOMOUS_STARTUP_DELAY_MS) || 30_000,
);
const autonomousMaxSteps = Math.min(
  20,
  Math.max(1, Number(process.env.AUTONOMOUS_MAX_STEPS) || 8),
);
const autonomousTask =
  process.env.AUTONOMOUS_TASK ||
  "Работай в режиме свободного плавания. Найди один полезный следующий шаг для Дмитрия или Ники, либо одну реалистичную идею дохода или организации дня на основе памяти и доступных инструментов. Сохраняй в память только действительно новые выводы и заверши работу через done с коротким резюме.";

if (!authToken) {
  console.error("PROXY_AUTH_TOKEN is required");
  process.exit(1);
}

const providers = createProviders();
const router = new ModelRouter(providers);
const memory = new MemoryDB(dbPath);
logger.setMemory(memory);
const tools = new ToolExecutor(memory, router);
const rag = new RAGPipeline(memory, router);
tools.setRAG(rag);
const metrics = new Metrics({
  get currentLoad() {
    return router.stats.currentLoad;
  },
  get queueLength() {
    return router.stats.queueLength;
  },
  get availableSlots() {
    return router.stats.availableSlots;
  },
});
const pipeline = new AgentPipeline(memory, router, rag);
pipeline.setMetrics(metrics);
const room = new ArbitrationRoom(router);
room.setMetrics(metrics);
pipeline.setArbitrationRoom(room);
const nightCycle = new NightCycle(memory, router, rag);
const agentLoop = new AgentLoop(memory, router, rag, tools);
agentLoop.setMetrics(metrics);
agentLoop.setRoom(room);

// ─── Telegram Userbot (MTProto chat reader, optional) ─────
let userbot: Userbot | null = null;
const tgApiId = Number(process.env.TG_API_ID);
const tgApiHash = process.env.TG_API_HASH;
const tgSession = process.env.TG_SESSION;

if (tgApiId && tgApiHash && tgSession) {
  userbot = new Userbot({
    apiId: tgApiId,
    apiHash: tgApiHash,
    session: tgSession,
    memory,
  });
  tools.setUserbot(userbot);
  userbot
    .connect()
    .catch((err) =>
      logger.error("userbot", `Connection failed: ${err.message}`),
    );
} else {
  logger.info(
    "userbot",
    "Not configured (set TG_API_ID + TG_API_HASH + TG_SESSION)",
  );
}

// ─── Telegram Bot (optional) ──────────────────────────────
let telegramBot: TelegramBot | null = null;
const tgBotToken = process.env.TG_BOT_TOKEN;
const tgOwnerChatId = Number(process.env.TG_OWNER_CHAT_ID);
const tgWebhookSecret = process.env.TG_WEBHOOK_SECRET || authToken;

if (tgBotToken && tgOwnerChatId) {
  telegramBot = new TelegramBot({
    token: tgBotToken,
    ownerChatId: tgOwnerChatId,
    webhookSecret: tgWebhookSecret,
    memory,
    pipeline,
    router,
  });
  // Init bot (fetches botInfo from Telegram API) — non-blocking
  telegramBot
    .init()
    .catch((err) =>
      logger.error("telegram", `Bot init failed: ${err.message}`),
    );
} else {
  logger.info(
    "telegram",
    "Bot not configured (set TG_BOT_TOKEN + TG_OWNER_CHAT_ID)",
  );
}

const app = new Elysia()
  .use(staticPlugin({ assets: "public", prefix: "/" }))
  .decorate("memory", memory)
  .decorate("router", router)
  .decorate("tools", tools)
  .decorate("metrics", metrics)
  .decorate("nightCycle", nightCycle)
  // Telegram webhook — before auth (validated by secret_token header)
  .use(telegramRoute(telegramBot))
  .get("/health", ({ router }) => ({
    status: "ok",
    timestamp: Date.now(),
    rpm: router.stats,
  }))
  .get("/metrics", ({ metrics }) => metrics.snapshot())
  .post("/night-cycle", async ({ nightCycle }) => nightCycle.run())
  // Token endpoint — no Bearer required, protected by Caddy basic auth
  .get("/api/token", () => ({ token: authToken }))
  .use(authMiddleware(authToken))
  .use(chatRoute(router, pipeline, memory))
  .use(modelsRoute(router))
  .use(embeddingsRoute(router))
  .use(logsRoute(memory))
  .use(mcpRoute(tools))
  .use(autonomousRoute(agentLoop))
  .use(chatsRoute(memory))
  .listen(port);

console.log(`🧠 Subbrain proxy running on http://localhost:${port}`);

// ─── Scheduled Autonomous TeamLead ───────────────────────
if (autonomousEnabled) {
  const intervalMs = autonomousIntervalMinutes * 60_000;
  let autonomousRunning = false;

  const runAutonomous = (reason: "startup" | "interval") => {
    if (autonomousRunning) {
      logger.warn(
        "autonomous",
        `Scheduled run skipped: previous autonomous loop still running (${reason})`,
      );
      return;
    }

    autonomousRunning = true;
    logger.info("autonomous", `Scheduled run started (${reason})`, {
      meta: { maxSteps: autonomousMaxSteps },
    });

    agentLoop
      .run({
        task: autonomousTask,
        model: "teamlead",
        maxSteps: autonomousMaxSteps,
        sessionId: "autonomous-scheduler",
        priority: "low",
      })
      .then((result) => {
        logger.info(
          "autonomous",
          `Scheduled run finished: ${result.stoppedReason}`,
          {
            meta: {
              totalSteps: result.totalSteps,
              requestId: result.requestId,
              sessionId: result.sessionId,
              reason,
            },
          },
        );
      })
      .catch((err) => {
        logger.error(
          "autonomous",
          `Scheduled run failed: ${err instanceof Error ? err.message : err}`,
        );
      })
      .finally(() => {
        autonomousRunning = false;
      });
  };

  logger.info(
    "autonomous",
    `Scheduler enabled: every ${autonomousIntervalMinutes} min`,
    {
      meta: {
        intervalMs,
        maxSteps: autonomousMaxSteps,
        startupDelayMs: autonomousStartupDelayMs,
      },
    },
  );

  setTimeout(() => runAutonomous("startup"), autonomousStartupDelayMs);
  setInterval(() => runAutonomous("interval"), intervalMs);
} else {
  logger.info("autonomous", "Scheduler disabled");
}

// ─── Auto-set Telegram webhook in production ────────────────
if (telegramBot && process.env.TG_WEBHOOK_URL) {
  telegramBot
    .setWebhook(process.env.TG_WEBHOOK_URL)
    .catch((err) =>
      logger.error("telegram", `Webhook setup failed: ${err.message}`),
    );
} else if (telegramBot && process.env.TG_POLLING === "true") {
  telegramBot.startPolling();
}

// Export for notifications from other modules (night-cycle, autonomous)
export { telegramBot };
