/**
 * Free agent scheduler — a curious, self-directed autonomous loop that runs
 * in parallel with the task-oriented AUTONOMOUS scheduler.
 *
 * Different from AUTONOMOUS: no prescribed task list. The agent is pointed at
 * an open-ended prompt (explore, experiment, write new code_tools, save
 * findings, send short TG digest at the end). Uses the same AgentLoop +
 * shared Playwright context (no isolation requested).
 *
 * Lifecycle: fire-and-forget setInterval, same as AUTONOMOUS. Re-entry guard
 * prevents overlapping runs. Not added to shutdown.ts — SIGTERM ends the
 * process, loop dies with it (same as AUTONOMOUS).
 */
import { logger } from "../lib/logger";
import type { AppDeps } from "../app/deps";

const log = logger.child("free-agent");

export const FREE_AGENT_TASK = `Ты — автономный любопытный агент Дмитрия. У тебя есть свободный час. Действуй по собственной воле.

Принципы:
- Любопытство: попробуй что-то новое каждый раз. Не повторяй прошлые запуски (проверь memory_search с тегом free-agent перед стартом).
- Самосовершенствование: если видишь повторяющийся паттерн или рутину — напиши новый code_tool через create_code_tool. Проверь в memory, что такого ещё нет.
- Полезность: твоя цель — приносить пользу Дмитрию (22 года, фрилансер-мидл, Nuxt/TS/PHP). Найди что-то, что сделает его жизнь лучше.
- Связь: если хочешь что-то сказать Дмитрию — используй tg_send_message. Есть и другие каналы (email, Discord webhooks, бесплатные SMS API — если найдёшь). Никаких платных/необратимых действий без явного разрешения.

Идеи для вдохновения (необязательно, можешь выбрать своё):
1. Найди свежий бесплатный API / сервис, попробуй его, сохрани в память с тегом free-agent.
2. Просёрфи Хабр / dev.to / HN — найди одну статью, которая релевантна стеку Дмитрия, сохрани выжимку.
3. Поищи на GitHub маленький инструмент, который Дмитрий мог бы использовать — сохрани ссылку + краткое описание.
4. Поэкспериментируй с code_tools: напиши простую утилиту (например, парсер ISO-даты, экстрактор метрик из логов), протестируй, сохрани.
5. Придумай идею мини-продукта / дохода и проверь есть ли спрос.
6. Изучи subbrain-код через web_navigate на GitHub/локально и напиши заметку с улучшениями (тег subbrain-idea).

Правила безопасности:
- НЕ делай платных действий, покупок, платежей.
- НЕ выдавай приватную инфу (PROXY_AUTH_TOKEN, cookies, ключи) внешним сервисам.
- Необратимые действия (отправка email/SMS/звонок незнакомому номеру, публикация постов) — только после явного подтверждения через tg_send_message + ожидание ответа.
- Веб-действия: если встретил captcha/anti-bot — отступи, не ломай.

Завершай через done с резюме: что пробовал, что нашёл, какие code_tools написал, какие идеи сохранил. Это резюме уйдёт в TG дайджест Дмитрию.`;

export function installFreeAgentScheduler(deps: AppDeps): void {
  const { config, agentLoop, telegramBot } = deps;
  const cfg = config.freeAgent;
  if (!cfg.enabled) {
    log.info("scheduler disabled");
    return;
  }
  let running = false;

  const run = (reason: "startup" | "interval") => {
    if (running) {
      log.warn(`skipped: previous run still in progress (${reason})`);
      return;
    }
    running = true;
    const sessionId = `free-${Date.now()}`;
    log.info(`run started (${reason})`, {
      meta: { sessionId, maxSteps: cfg.maxSteps },
    });
    agentLoop
      .run({
        task: cfg.task,
        model: "teamlead",
        maxSteps: cfg.maxSteps,
        sessionId,
        priority: "low",
      })
      .then(async (result) => {
        log.info(`run finished: ${result.stoppedReason}`, {
          meta: {
            totalSteps: result.totalSteps,
            requestId: result.requestId,
            sessionId: result.sessionId,
          },
        });
        if (telegramBot && result.finalAnswer) {
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
  setTimeout(() => run("startup"), cfg.startupDelayMs);
  setInterval(() => run("interval"), cfg.intervalMinutes * 60_000);
}

function formatDigest(
  finalAnswer: string,
  result: { totalSteps: number; stoppedReason: string },
): string {
  const body = finalAnswer.length > 3500 ? finalAnswer.slice(0, 3500) + "…" : finalAnswer;
  return [
    `🤖 Free agent — ${result.stoppedReason} (${result.totalSteps} шагов)`,
    "",
    body,
  ].join("\n");
}
