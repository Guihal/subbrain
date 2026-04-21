import { logger } from "../lib/logger";
import type { AppDeps } from "./deps";

export function registerShutdown(deps: AppDeps): void {
  const { memory, playwright, telegramPoller, freelanceScout } = deps;
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutdown", `Received ${signal}, closing`);
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
