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
    `Ты — личный ИИ-ассистент Дмитрия (22 года, мидл-фрилансер, стек: Nuxt/TypeScript/PHP).
Каждый запуск выбери ОДНУ задачу из списка ниже и выполни её до конца:

1. **Телеграм-дайджест** — используй \`tg_list_chats\` → \`tg_read_chat\` для обзора непрочитанных сообщений + \`web_navigate\` для поиска актуальных новостей. Сохрани выжимку в память + отправь сводку через tg_send_message.
2. **Полезные статьи** — найди 1-2 свежих статьи на Хабре, dev.to или аналогах по стеку (Nuxt, TypeScript, Vue, PHP, Node.js). Сохрани выжимку в память + отправь в ТГ.
3. **Вакансии и заказы** — поищи на hh.ru, Хабр Карьере, Upwork, Freelancehunt интересные вакансии/заказы по стеку. Сохрани лучшие находки + отправь в ТГ.
4. **Книги и курсы** — найди 1 книгу или курс, который поможет вырасти (архитектура, паттерны, soft skills, финансы для фрилансера). Сохрани в память.
5. **Идея дохода** — придумай одну конкретную, реалистичную, ЛЕГАЛЬНУЮ идею заработка на основе стека и навыков Дмитрия. Проверь через интернет, есть ли спрос. Сохрани PoC-план в память.
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
  };
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
  return bot;
}
