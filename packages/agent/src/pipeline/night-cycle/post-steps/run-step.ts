import { logger } from "@subbrain/core/lib/logger";
import type { NightCycleResult } from "../types";

const log = logger.child("night.post");

export async function runStep(
  banner: string,
  errKey: string,
  fn: () => Promise<void>,
  result: NightCycleResult,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    result.errors.push(`${errKey}: aborted`);
    return;
  }
  log.info(`${banner}…`);
  try {
    await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`${banner} failed: ${msg}`);
    result.errors.push(`${errKey}: ${msg}`);
  }
}
