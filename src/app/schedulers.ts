import { logger } from "../lib/logger";
import type { AppDeps } from "./deps";
import type { NightCycleController } from "./night-cycle-controller";

export function installAutonomousScheduler(deps: AppDeps): void {
  const { config, agentLoop } = deps;
  const { autonomous } = config;
  if (!autonomous.enabled) {
    logger.info("autonomous", "Scheduler disabled");
    return;
  }

  const intervalMs = autonomous.intervalMinutes * 60_000;
  let running = false;

  const run = (reason: "startup" | "interval") => {
    if (running) {
      logger.warn(
        "autonomous",
        `Scheduled run skipped: previous autonomous loop still running (${reason})`,
      );
      return;
    }
    running = true;
    logger.info("autonomous", `Scheduled run started (${reason})`, {
      meta: { maxSteps: autonomous.maxSteps },
    });

    const sessionId = `auto-${Date.now()}`;
    agentLoop
      .run({
        task: autonomous.task,
        model: "teamlead",
        maxSteps: autonomous.maxSteps,
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
        running = false;
      });
  };

  logger.info(
    "autonomous",
    `Scheduler enabled: every ${autonomous.intervalMinutes} min`,
    {
      meta: {
        intervalMs,
        maxSteps: autonomous.maxSteps,
        startupDelayMs: autonomous.startupDelayMs,
      },
    },
  );

  setTimeout(() => run("startup"), autonomous.startupDelayMs);
  setInterval(() => run("interval"), intervalMs);
}

export function installNightCycleScheduler(
  deps: AppDeps,
  controller: NightCycleController,
): void {
  const { config, memory } = deps;
  const { nightCycle: cfg } = config;
  if (!cfg.schedulerEnabled) {
    logger.info("night", "In-process scheduler disabled (NIGHT_CYCLE_SCHEDULER=false)");
    return;
  }

  const msUntilNext = (): number => {
    const now = new Date();
    const target = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        cfg.hourUtc,
        0,
        0,
        0,
      ),
    );
    if (target.getTime() <= now.getTime()) {
      target.setUTCDate(target.getUTCDate() + 1);
    }
    return target.getTime() - now.getTime();
  };

  const schedule = (): void => {
    const delay = msUntilNext();
    setTimeout(() => {
      controller.trigger("scheduled");
      schedule();
    }, delay);
    logger.info(
      "night",
      `Next scheduled run in ${Math.round(delay / 60_000)} min (target ${cfg.hourUtc}:00 UTC)`,
    );
  };

  schedule();

  setTimeout(() => {
    const lastIdStr = memory.getFocus("night_cycle_last_processed_id");
    const lastId = lastIdStr ? parseInt(lastIdStr, 10) : 0;
    const backlog = memory.getLogsSince(lastId, 1000).length;
    if (backlog >= cfg.backlogTrigger) {
      logger.info(
        "night",
        `Startup catch-up: ${backlog} unprocessed logs (≥${cfg.backlogTrigger} threshold)`,
      );
      controller.trigger("startup-backlog");
    } else {
      logger.info(
        "night",
        `Startup catch-up not needed (backlog=${backlog} < ${cfg.backlogTrigger})`,
      );
    }
  }, 120_000);
}

export function installTelegramPoller(deps: AppDeps): void {
  const { telegramPoller } = deps;
  if (!telegramPoller) return;
  telegramPoller.start();
}

export function installFreelanceScoutScheduler(deps: AppDeps): void {
  const { freelanceScout } = deps;
  if (!freelanceScout) return;
  freelanceScout.start();
}

export function installTelegramWebhook(deps: AppDeps): void {
  const { telegramBot, config } = deps;
  if (!telegramBot) return;
  if (config.telegram.webhookUrl) {
    telegramBot
      .setWebhook(config.telegram.webhookUrl)
      .catch((err) =>
        logger.error("telegram", `Webhook setup failed: ${err.message}`),
      );
  } else if (config.telegram.polling) {
    telegramBot.startPolling();
  }
}
