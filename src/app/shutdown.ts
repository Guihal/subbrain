import { logger } from "../lib/logger";
import type { AppDeps } from "./deps";

export function registerShutdown(deps: AppDeps): void {
  const { memory, playwright } = deps;
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutdown", `Received ${signal}, closing`);
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
