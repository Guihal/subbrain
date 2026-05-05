import { logger } from "@subbrain/core/lib/logger";
import type { NightCycle } from "../pipeline";

const log = logger.child("night");

export type TriggerReason = "http" | "scheduled" | "startup-backlog";

export interface TriggerResult {
  started: boolean;
  reason?: string;
  since?: number | null;
  startedAt?: number;
}

export class NightCycleController {
  running = false;
  startedAt: number | null = null;
  lastResult: unknown = null;

  constructor(private cycle: NightCycle) {}

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
    this.cycle
      .run()
      .then((res) => {
        this.lastResult = res;
        if (reason === "http") {
          log.info("Run complete (HTTP-triggered)", { meta: { ...res } });
        } else {
          log.info(
            `Run complete (${reason}): archived=${res.archiveEntriesCreated} errors=${res.errors.length}`,
            { meta: { ...res, reason } },
          );
        }
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`Run failed${reason === "http" ? "" : ` (${reason})`}: ${msg}`);
        this.lastResult = reason === "http" ? { error: msg } : { error: msg, reason };
      })
      .finally(() => {
        this.running = false;
      });
    return { started: true, startedAt: this.startedAt };
  }
}
