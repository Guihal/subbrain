
import { logger } from "@subbrain/core/lib/logger";
import type { AgentService } from "../services/agent.service";
import type { TelegramBot } from "../telegram/bot";

const log = logger.child("free-agent");

export interface FreeAgentSchedulerDeps {
  agentService: AgentService;
  telegramBot: TelegramBot | null;
  config: {
    freeAgent: {
      enabled: boolean;
      intervalMinutes: number;
      startupDelayMs: number;
      maxSteps: number;
      task: string;
    };
  };
}

export const FREE_AGENT_TASK = `Ты — автономный любопытный агент пользователя. У тебя есть свободный час. Действуй по собственной воле. Профиль пользователя — в shared_memory.

Принципы:
- **Любопытство.** Пробуй новое. Перед стартом — memory_search по тегу "free-agent" за последние 7 дней, не повторяйся.
- **Самосовершенствование.** Повторяющийся паттерн → прогоняй через существующие code_tools/динамические тулы. Создание нового кода в scheduled-режиме отключено (SCHED-1); сохрани идею через memory_write с тегом tool-proposal — создадим вручную.
- **Полезность.** Сверяйся с shared_memory — стек, цели, болевые точки. Действие должно соответствовать профилю, а не абстрактной «пользе».
- **Связь.** tg_send_message — основной канал. Альтернативы (email, Discord webhooks, бесплатные SMS API) допустимы, но см. «Правила безопасности» ниже.

Идеи для вдохновения (необязательно, можешь выбрать своё):
1. Найди свежий бесплатный API / сервис по теме пользовательского стека, попробуй его, сохрани с тегом free-agent.
2. Просёрфи Хабр / dev.to / HN — найди одну статью, релевантную стеку пользователя (см. shared_memory), сохрани выжимку.
3. Поищи на GitHub маленький инструмент, подходящий под стек пользователя — сохрани ссылку + описание.
4. Прогони уже существующие code_tools (см. list_code_tools) на новых входах, найди edge-cases, запиши через memory_write.
5. Придумай идею мини-продукта / дохода под профиль пользователя и проверь спрос.
6. Изучи subbrain-код через web_navigate и напиши заметку с улучшениями (тег subbrain-idea).

Правила безопасности:
- НЕ делай платных действий, покупок, платежей.
- НЕ выдавай приватную инфу (PROXY_AUTH_TOKEN, cookies, ключи) внешним сервисам.
- Необратимые действия (email/SMS/звонок незнакомому номеру, публикация постов) — только после явного подтверждения через tg_send_message + ожидание ответа.
- Веб: captcha/anti-bot — отступи.

Завершай через done с резюме: что пробовал, что нашёл, какие code_tools написал, какие идеи сохранил. Резюме уйдёт в TG-дайджест пользователю.`;

export function installFreeAgentScheduler(deps: FreeAgentSchedulerDeps): { stop: () => void } {
  const { config, agentService, telegramBot } = deps;
  const cfg = config.freeAgent;
  if (!cfg.enabled) {
    log.info("scheduler disabled");
    return { stop: () => {} };
  }
  let running = false;
  let stopped = false;
  let startupTimer: ReturnType<typeof setTimeout> | null = null;
  let intervalTimer: ReturnType<typeof setInterval> | null = null;

  const run = (reason: "startup" | "interval") => {
    if (stopped) return;
    if (running) {
      log.warn(`skipped: previous run still in progress (${reason})`);
      return;
    }
    running = true;
    const sessionId = `free-${Date.now()}`;
    log.info(`run started (${reason})`, {
      meta: { sessionId, maxSteps: cfg.maxSteps },
    });
    agentService
      .run({
        task: cfg.task,
        model: "teamlead",
        maxSteps: cfg.maxSteps,
        sessionId,
        priority: "low",
        // SCHED-1: no human in the loop — hide code-tool authoring.
        agentMode: "scheduled",
        // B-1: per-agent identity for context-layer scoping.
        agentId: "free-agent",
        schedule: {
          intervalMinutes: cfg.intervalMinutes,
          source: "free-agent",
        },
      })
      .then(async (result) => {
        log.info(`run finished: ${result.stoppedReason}`, {
          meta: {
            totalSteps: result.totalSteps,
            requestId: result.requestId,
            sessionId: result.sessionId,
          },
        });
        if (telegramBot && result.finalAnswer?.trim()) {
          const digest = formatDigest(result.finalAnswer, result);
          try {
            await telegramBot.notify(digest);
          } catch (err) {
            log.warn("digest send failed", {
              meta: { err: err instanceof Error ? err.message : String(err) },
            });
          }
        }
      })
      .catch((err) => {
        log.error(`run failed: ${err instanceof Error ? err.message : err}`);
      })
      .finally(() => {
        running = false;
      });
  };

  log.info(`enabled: every ${cfg.intervalMinutes} min`, {
    meta: {
      intervalMs: cfg.intervalMinutes * 60_000,
      maxSteps: cfg.maxSteps,
      startupDelayMs: cfg.startupDelayMs,
    },
  });
  startupTimer = setTimeout(() => run("startup"), cfg.startupDelayMs);
  intervalTimer = setInterval(() => run("interval"), cfg.intervalMinutes * 60_000);

  return {
    stop: () => {
      stopped = true;
      if (startupTimer) clearTimeout(startupTimer);
      if (intervalTimer) clearInterval(intervalTimer);
      startupTimer = null;
      intervalTimer = null;
    },
  };
}

function formatDigest(
  finalAnswer: string,
  result: { totalSteps: number; stoppedReason: string },
): string {
  const body = finalAnswer.length > 3500 ? `${finalAnswer.slice(0, 3500)}…` : finalAnswer;
  return [`🤖 Free agent — ${result.stoppedReason} (${result.totalSteps} шагов)`, "", body].join(
    "\n",
  );
}
