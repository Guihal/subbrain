import { logger } from "../lib/logger";
import type { AppDeps } from "./deps";

export interface ShutdownScheduler {
  stop: () => void | Promise<void>;
}

export function registerShutdown(
  deps: AppDeps,
  schedulers: ShutdownScheduler[] = [],
): void {
  const { memory, playwright, telegramPoller, freelanceScout } = deps;
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutdown", `Received ${signal}, closing`);

    if (schedulers.length > 0) {
      const SCHEDULER_STOP_TIMEOUT_MS = 2000;
      const settled = Promise.allSettled(
        schedulers.map((s) => Promise.resolve().then(() => s.stop())),
      );
      const timeout = new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), SCHEDULER_STOP_TIMEOUT_MS),
      );
      const result = await Promise.race([settled, timeout]);
      if (result === "timeout") {
        logger.warn(
          "shutdown",
          `schedulers stop timed out after ${SCHEDULER_STOP_TIMEOUT_MS}ms`,
        );
      }
    }

    if (freelanceScout) {
      try {
        await freelanceScout.stop();
      } catch (err) {
        logger.error(
          "shutdown",
          `freelance scout stop failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    if (telegramPoller) {
      try {
        telegramPoller.stop();
      } catch (err) {
        logger.error(
          "shutdown",
          `telegram poller stop failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    try {
      logger.info(
        "shutdown",
        `playwright open contexts before close: ${playwright.contextCount}`,
      );
      await playwright.close();
    } catch (err) {
      logger.error(
        "shutdown",
        `playwright close failed: ${err instanceof Error ? err.message : err}`,
      );
    }
    try {
      memory.close();
    } catch (err) {
      logger.error(
        "shutdown",
        `memory close failed: ${err instanceof Error ? err.message : err}`,
      );
    }
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}
