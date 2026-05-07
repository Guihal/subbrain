import { access } from "node:fs/promises";
import { runBackup } from "@subbrain/core/db/backup";
import { logger } from "@subbrain/core/lib/logger";
import type { AppDeps } from "./deps";

const DAY_MS = 86_400_000;

export function installBackupScheduler(deps: AppDeps): { stop: () => void } {
  const { memory } = deps;
  const hourUtc = Number(process.env.BACKUP_HOUR_UTC ?? 4);
  const enabled = process.env.BACKUP_ENABLED !== "false";

  if (!enabled) {
    logger.info("backup", "Scheduler disabled (BACKUP_ENABLED=false)");
    return { stop: () => {} };
  }

  let inFlight = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const targetForDate = (d: Date): string => {
    const suffix = d.toISOString().slice(0, 10);
    return `${process.env.BACKUP_DIR || "data/backups"}/subbrain-${suffix}.db`;
  };

  const msUntilNext = (): number => {
    const now = new Date();
    const target = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc, 0, 0, 0),
    );
    if (target.getTime() <= now.getTime()) {
      target.setUTCDate(target.getUTCDate() + 1);
    }
    return target.getTime() - now.getTime();
  };

  const tick = async (): Promise<void> => {
    if (stopped || inFlight) return;
    const target = targetForDate(new Date());
    try {
      await access(target);
      logger.info("backup", "Skip: today's backup already exists", { meta: { target } });
      return;
    } catch {
      // ENOENT → proceed
    }
    inFlight = true;
    try {
      const result = await runBackup(memory, target);
      logger.info("backup", "Daily backup completed", { meta: { ...result } });
    } catch (err) {
      logger.error("backup", `Backup failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      inFlight = false;
    }
  };

  const schedule = (): void => {
    const delay = msUntilNext();
    timer = setTimeout(() => {
      tick().catch(() => {});
      timer = setInterval(() => {
        tick().catch(() => {});
      }, DAY_MS);
    }, delay);
    logger.info(
      "backup",
      `Next scheduled run in ${Math.round(delay / 60_000)} min (target ${hourUtc}:00 UTC)`,
    );
  };

  schedule();

  return {
    stop: () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
