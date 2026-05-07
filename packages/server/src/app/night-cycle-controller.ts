import type { NightCycle, NightCycleResult } from "@subbrain/agent/pipeline";
import { logger } from "@subbrain/core/lib/logger";

const log = logger.child("night");

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 min

export type TriggerReason = "http" | "scheduled" | "startup-backlog";

export interface TriggerResult {
  started: boolean;
  reason?: string;
  since?: number | null;
  startedAt?: number;
}

export interface WatchdogResult {
  abortedReason: "watchdog";
  timeoutMs: number;
}

export class NightCycleController {
  running = false;
  startedAt: number | null = null;
  lastResult: NightCycleResult | WatchdogResult | { error: string } | null = null;

  constructor(
    private cycle: NightCycle,
    private timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  trigger(reason: TriggerReason): TriggerResult {
    if (this.running) {
      if (reason === "http") {
        return { started: false, reason: "already_running", since: this.startedAt };
      }
      log.info(`Skipping ${reason}: already running`);
      return { started: false, reason: "already_running", since: this.startedAt };
    }
    this.running = true;
    this.startedAt = Date.now();
    if (reason !== "http") {
      log.info(`Run starting (${reason})`);
    }
    void this.runWithWatchdog(reason);
    return { started: true, startedAt: this.startedAt };
  }

  private async runWithWatchdog(reason: TriggerReason): Promise<void> {
    let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
    const watchdog = new Promise<WatchdogResult>((resolve) => {
      watchdogTimer = setTimeout(() => {
        resolve({ abortedReason: "watchdog", timeoutMs: this.timeoutMs });
      }, this.timeoutMs);
      watchdogTimer.unref?.();
    });
    try {
      const res = await Promise.race([this.cycle.run(), watchdog]);
      if ("abortedReason" in res) {
        log.error(
          `Watchdog fired: cycle exceeded ${this.timeoutMs}ms (${reason}); resetting running flag`,
        );
        this.lastResult = res;
      } else {
        this.lastResult = res;
        if (reason === "http") {
          log.info("Run complete (HTTP-triggered)", { meta: { ...res } });
        } else {
          log.info(
            `Run complete (${reason}): archived=${res.archiveEntriesCreated} errors=${res.errors.length}`,
            { meta: { ...res, reason } },
          );
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`Run failed${reason === "http" ? "" : ` (${reason})`}: ${msg}`);
      this.lastResult = reason === "http" ? { error: msg } : { error: msg };
    } finally {
      if (watchdogTimer) clearTimeout(watchdogTimer);
      this.running = false;
    }
  }
}
