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
import {
  ToolExecutor,
  mcpRoute,
  PlaywrightClient,
  mcpProtocolRoute,
} from "./mcp";
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
  Number(process.env.AUTONOMOUS_INTERVAL_MINUTES) || 30,
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
  `Ты — личный ИИ-ассистент Дмитрия (22 года, мидл-фрилансер, стек: Nuxt/TypeScript/PHP).
Каждый запуск выбери ОДНУ задачу из списка ниже и выполни её до конца:

1. **Телеграм-дайджест** — используй \`tg_list_chats\` → \`tg_read_chat\` для обзора непрочитанных сообщений + \`web_navigate\` для поиска актуальных новостей. Сохрани выжимку в память + отправь сводку через tg_send_message.
2. **Полезные статьи** — найди 1-2 свежих статьи на Хабре, dev.to или аналогах по стеку (Nuxt, TypeScript, Vue, PHP, Node.js). Сохрани выжимку в память + отправь в ТГ.
3. **Вакансии и заказы** — поищи на hh.ru, Хабр Карьере, Upwork, Freelancehunt интересные вакансии/заказы по стеку. Сохрани лучшие находки + отправь в ТГ.
4. **Книги и курсы** — найди 1 книгу или курс, который поможет вырасти (архитектура, паттерны, soft skills, финансы для фрилансера). Сохрани в память.
5. **Идея дохода** — придумай одну конкретную, реалистичную, ЛЕГАЛЬНУЮ идею заработка на основе стека и навыков Дмитрия. Проверь через интернет, есть ли спрос. Сохрани PoC-план в память.
6. **Оптимизация рутины** — проанализируй память и Telegram, найди повторяющиеся задачи, которые можно автоматизировать. Предложи конкретное решение.

Правила: проверяй в memory_search, не делал ли ты эту задачу недавно (< 24ч). Если делал — выбери другую. Завершай через done с резюме.`;

if (!authToken) {
  console.error("PROXY_AUTH_TOKEN is required");
  process.exit(1);
}

const providers = await createProviders();
const router = new ModelRouter(providers);
const memory = new MemoryDB(dbPath);
logger.setMemory(memory);
const tools = new ToolExecutor(memory, router);
const rag = new RAGPipeline(memory, router);
tools.setRAG(rag);
const playwright = new PlaywrightClient();
tools.setPlaywright(playwright);
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

// ─── Telegram Userbot (MTProto — reads user's chats) ──────
const tgApiId = Number(process.env.TG_API_ID);
const tgApiHash = process.env.TG_API_HASH || "";
const tgSession = process.env.TG_SESSION || "";

if (tgApiId && tgApiHash && tgSession) {
  const userbot = new Userbot({
    apiId: tgApiId,
    apiHash: tgApiHash,
    session: tgSession,
    memory,
  });
  userbot
    .connect()
    .then(() => {
      tools.setUserbot(userbot);
      logger.info("userbot", "MTProto userbot connected");
    })
    .catch((err) =>
      logger.error("userbot", `Userbot connect failed: ${err.message}`),
    );
} else {
  logger.info(
    "userbot",
    "Userbot not configured (set TG_API_ID + TG_API_HASH + TG_SESSION)",
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
  // Wire bot notify into tool executor for tg_send_message tool
  tools.setBotNotify((text) => telegramBot!.notify(text));
} else {
  logger.info(
    "telegram",
    "Bot not configured (set TG_BOT_TOKEN + TG_OWNER_CHAT_ID)",
  );
}

const app = new Elysia()
  .onError(({ code, error, set, path }) => {
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
  })
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
  // MCP SSE/messages route — placed BEFORE authMiddleware because it handles
  // its own auth internally and some clients (Continue) may not send the header
  // on every POST (they attach it per-session, not per-request).
  .use(mcpProtocolRoute(tools, authToken))
  .use(authMiddleware(authToken))
  .use(chatRoute(router, pipeline, memory))
  .use(modelsRoute(router))
  .use(embeddingsRoute(router))
  .use(logsRoute(memory))
  .use(mcpRoute(tools))
  .use(autonomousRoute(agentLoop, memory))
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

    const sessionId = `auto-${Date.now()}`;
    const dateStr = new Date().toLocaleString("ru-RU", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });

    agentLoop
      .run({
        task: autonomousTask,
        model: "teamlead",
        maxSteps: autonomousMaxSteps,
        sessionId,
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
