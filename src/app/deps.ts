import { createProviders } from "../providers";
import { ModelRouter } from "../lib/model-router";
import { MemoryDB } from "../db";
import { ToolExecutor, PlaywrightClient, buildRegistry } from "../mcp";
import type { ToolRegistry } from "../mcp";
import { RAGPipeline } from "../rag";
import {
  AgentPipeline,
  ArbitrationRoom,
  NightCycle,
  AgentLoop,
} from "../pipeline";
import { TelegramBot, Userbot } from "../telegram";
import { TelegramPoller } from "../scheduler/telegram-poller";
import { FreelanceScout, type FreelanceScoutConfig } from "../scheduler/freelance";
import { FREE_AGENT_TASK } from "../scheduler/free-agent";
import { Metrics } from "../lib/metrics";
import { logger } from "../lib/logger";

export interface AppConfig {
  port: number;
  authToken: string;
  dbPath: string;
  autonomous: {
    enabled: boolean;
    intervalMinutes: number;
    startupDelayMs: number;
    maxSteps: number;
    task: string;
  };
  nightCycle: {
    schedulerEnabled: boolean;
    hourUtc: number;
    backlogTrigger: number;
  };
  telegram: {
    webhookUrl?: string;
    polling: boolean;
  };
  telegramPoller: {
    enabled: boolean;
    remindChatId: string;
    pollIntervalMs: number;
    remindIntervalMs: number;
    staleHours: number;
    remindModel: string;
  };
  freelance: FreelanceScoutConfig;
  freeAgent: {
    enabled: boolean;
    intervalMinutes: number;
    startupDelayMs: number;
    maxSteps: number;
    task: string;
  };
}

export interface AppDeps {
  config: AppConfig;
  memory: MemoryDB;
  router: ModelRouter;
  rag: RAGPipeline;
  tools: ToolExecutor;
  registry: ToolRegistry;
  playwright: PlaywrightClient;
  metrics: Metrics;
  pipeline: AgentPipeline;
  room: ArbitrationRoom;
  nightCycle: NightCycle;
  agentLoop: AgentLoop;
  telegramBot: TelegramBot | null;
  userbot: Userbot | null;
  telegramPoller: TelegramPoller | null;
  freelanceScout: FreelanceScout | null;
}

export function loadConfig(): AppConfig {
  const authToken = process.env.PROXY_AUTH_TOKEN;
  if (!authToken) {
    console.error("PROXY_AUTH_TOKEN is required");
    process.exit(1);
  }
  const autonomousEnabled =
    process.env.AUTONOMOUS_ENABLED === "true" ||
    (process.env.AUTONOMOUS_ENABLED !== "false" &&
      process.env.NODE_ENV === "production");
  const autonomousTask =
    process.env.AUTONOMOUS_TASK ||
    `Ты — личный ИИ-ассистент пользователя в автономном режиме. Профиль, стек и миссия — в shared_memory.
Каждый запуск выбери ОДНУ задачу из списка ниже и выполни её до конца:

1. **Телеграм-дайджест** — используй \`tg_list_chats\` → \`tg_read_chat\` для обзора непрочитанных сообщений + \`web_navigate\` для поиска актуальных новостей. Сохрани выжимку в память + отправь сводку через tg_send_message.
2. **Полезные статьи** — найди 1-2 свежих статьи на Хабре, dev.to или аналогах по стеку (Nuxt, TypeScript, Vue, PHP, Node.js). Сохрани выжимку в память + отправь в ТГ.
3. **Вакансии и заказы** — поищи на hh.ru, Хабр Карьере, Upwork, Freelancehunt интересные вакансии/заказы по стеку. Сохрани лучшие находки + отправь в ТГ.
4. **Книги и курсы** — найди 1 книгу или курс, который поможет вырасти (архитектура, паттерны, soft skills, финансы для фрилансера). Сохрани в память.
5. **Идея дохода** — придумай одну конкретную, реалистичную, ЛЕГАЛЬНУЮ идею заработка на основе стека и навыков пользователя (см. shared_memory). Проверь через интернет, есть ли спрос. Сохрани PoC-план в память.
6. **Оптимизация рутины** — проанализируй память и Telegram, найди повторяющиеся задачи, которые можно автоматизировать. Предложи конкретное решение.

Правила: проверяй в memory_search, не делал ли ты эту задачу недавно (< 24ч). Если делал — выбери другую. Завершай через done с резюме.`;

  return {
    port: Number(process.env.PROXY_PORT) || 4000,
    authToken,
    dbPath: process.env.DB_PATH || "data/subbrain.db",
    autonomous: {
      enabled: autonomousEnabled,
      intervalMinutes: Math.max(
        1,
        Number(process.env.AUTONOMOUS_INTERVAL_MINUTES) || 30,
      ),
      startupDelayMs: Math.max(
        0,
        Number(process.env.AUTONOMOUS_STARTUP_DELAY_MS) || 30_000,
      ),
      maxSteps: Math.min(
        100,
        Math.max(1, Number(process.env.AUTONOMOUS_MAX_STEPS) || 100),
      ),
      task: autonomousTask,
    },
    nightCycle: {
      schedulerEnabled: process.env.NIGHT_CYCLE_SCHEDULER !== "false",
      hourUtc: Number(process.env.NIGHT_CYCLE_HOUR_UTC ?? 3),
      backlogTrigger: Number(process.env.NIGHT_CYCLE_BACKLOG_TRIGGER ?? 100),
    },
    telegram: {
      webhookUrl: process.env.TG_WEBHOOK_URL,
      polling: process.env.TG_POLLING === "true",
    },
    telegramPoller: {
      enabled: process.env.TG_POLLER === "true",
      remindChatId: process.env.TG_REMIND_CHAT_ID || "",
      pollIntervalMs: Math.max(
        60_000,
        (Number(process.env.TG_POLL_INTERVAL_MIN) || 10) * 60_000,
      ),
      remindIntervalMs: Math.max(
        60_000,
        (Number(process.env.TG_REMIND_INTERVAL_MIN) || 30) * 60_000,
      ),
      staleHours: Math.max(
        1,
        Number(process.env.TG_REMIND_STALE_HOURS) || 6,
      ),
      remindModel: process.env.TG_REMIND_MODEL || "flash",
    },
    freelance: {
      enabled: process.env.FREELANCE_SCOUT === "true",
      pollMs: Math.max(
        60_000,
        (Number(process.env.FREELANCE_POLL_MIN) || 30) * 60_000,
      ),
      categories: (process.env.FREELANCE_CATEGORIES || "web,backend,bots,scripts")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
      minBudget: Number(process.env.FREELANCE_MIN_BUDGET) || 2000,
      maxBudget: Number(process.env.FREELANCE_MAX_BUDGET) || 30000,
      threshold: Math.max(
        1,
        Math.min(10, Number(process.env.FREELANCE_THRESHOLD) || 7),
      ),
      tgChatId: process.env.FREELANCE_TG_CHAT_ID
        ? Number(process.env.FREELANCE_TG_CHAT_ID)
        : null,
    },
    freeAgent: {
      enabled: process.env.FREE_AGENT === "true",
      intervalMinutes: Math.max(
        5,
        Number(process.env.FREE_AGENT_INTERVAL_MIN) || 60,
      ),
      startupDelayMs: Math.max(
        0,
        Number(process.env.FREE_AGENT_STARTUP_DELAY_MS) || 60_000,
      ),
      maxSteps: Math.min(
        100,
        Math.max(1, Number(process.env.FREE_AGENT_MAX_STEPS) || 50),
      ),
      task: process.env.FREE_AGENT_TASK || FREE_AGENT_TASK,
    },
  };
}

export async function initDeps(config: AppConfig = loadConfig()): Promise<AppDeps> {
  const providers = await createProviders();
  const router = new ModelRouter(providers);
  const memory = new MemoryDB(config.dbPath);
  logger.setMemory(memory);

  const registry = buildRegistry();
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
  tools.setRoom(room);

  const nightCycle = new NightCycle(memory, router, rag);
  const agentLoop = new AgentLoop(memory, router, rag, tools, registry);
  agentLoop.setMetrics(metrics);
  agentLoop.setRoom(room);

  const userbot = initUserbot(memory, tools);
  const telegramBot = initTelegramBot({
    memory,
    pipeline,
    router,
    tools,
    authToken: config.authToken,
  });
  const telegramPoller = initTelegramPoller({
    config,
    memory,
    router,
    userbot,
    telegramBot,
  });

  const freelanceScout = new FreelanceScout({
    db: memory,
    router,
    playwright,
    bot: telegramBot,
    config: config.freelance,
  });

  return {
    config,
    memory,
    router,
    rag,
    tools,
    registry,
    playwright,
    metrics,
    pipeline,
    room,
    nightCycle,
    agentLoop,
    telegramBot,
    userbot,
    telegramPoller,
    freelanceScout,
  };
}

function initTelegramPoller(opts: {
  config: AppConfig;
  memory: MemoryDB;
  router: ModelRouter;
  userbot: Userbot | null;
  telegramBot: TelegramBot | null;
}): TelegramPoller | null {
  const cfg = opts.config.telegramPoller;
  if (!cfg.enabled) {
    logger.info("tg-poller", "Disabled (TG_POLLER != true)");
    return null;
  }
  if (!cfg.remindChatId) {
    logger.warn("tg-poller", "Enabled but TG_REMIND_CHAT_ID not set — skipped");
    return null;
  }
  if (!opts.userbot || !opts.telegramBot) {
    logger.warn(
      "tg-poller",
      "Enabled but userbot or bot not configured — skipped",
    );
    return null;
  }
  const userbot = opts.userbot;
  const telegramBot = opts.telegramBot;
  return new TelegramPoller({
    memory: opts.memory,
    router: opts.router,
    readInbox: async (chatId, limit) => {
      const msgs = await userbot.readChat(chatId, limit);
      return msgs.map((m) => ({
        id: m.id,
        text: m.text,
        date: m.date,
        sender: m.sender,
      }));
    },
    sendNotify: (text) => telegramBot.notify(text),
    config: {
      remindChatId: cfg.remindChatId,
      pollIntervalMs: cfg.pollIntervalMs,
      remindIntervalMs: cfg.remindIntervalMs,
      staleHours: cfg.staleHours,
      remindModel: cfg.remindModel,
    },
  });
}

function initUserbot(memory: MemoryDB, tools: ToolExecutor): Userbot | null {
  const apiId = Number(process.env.TG_API_ID);
  const apiHash = process.env.TG_API_HASH || "";
  const session = process.env.TG_SESSION || "";
  if (!apiId || !apiHash || !session) {
    logger.info(
      "userbot",
      "Userbot not configured (set TG_API_ID + TG_API_HASH + TG_SESSION)",
    );
    return null;
  }
  const userbot = new Userbot({ apiId, apiHash, session, memory });
  userbot
    .connect()
    .then(() => {
      tools.setUserbot(userbot);
      logger.info("userbot", "MTProto userbot connected");
    })
    .catch((err) =>
      logger.error("userbot", `Userbot connect failed: ${err.message}`),
    );
  return userbot;
}

function initTelegramBot(opts: {
  memory: MemoryDB;
  pipeline: AgentPipeline;
  router: ModelRouter;
  tools: ToolExecutor;
  authToken: string;
}): TelegramBot | null {
  const token = process.env.TG_BOT_TOKEN;
  const ownerChatId = Number(process.env.TG_OWNER_CHAT_ID);
  if (!token || !ownerChatId) {
    logger.info(
      "telegram",
      "Bot not configured (set TG_BOT_TOKEN + TG_OWNER_CHAT_ID)",
    );
    return null;
  }
  const webhookSecret = process.env.TG_WEBHOOK_SECRET || opts.authToken;
  const bot = new TelegramBot({
    token,
    ownerChatId,
    webhookSecret,
    memory: opts.memory,
    pipeline: opts.pipeline,
    router: opts.router,
  });
  bot
    .init()
    .catch((err) =>
      logger.error("telegram", `Bot init failed: ${err.message}`),
    );
  opts.tools.setBotNotify((text) => bot.notify(text));
  bot.setReportSender(async (text) => {
    await opts.tools.sendReportEnriched(text);
  });
  return bot;
}
