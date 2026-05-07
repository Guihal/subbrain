import type { RequestLogger } from "@subbrain/core/lib/logger";
import { incrementCounter } from "@subbrain/core/lib/metrics";

export const MAX_WRITES_PER_EXCHANGE = 3;

export interface WriteGuard {
  writesCount: number;
  skippedDupCount: number;
}

export function createWriteGuard(): WriteGuard {
  return { writesCount: 0, skippedDupCount: 0 };
}

export function checkWriteCap(
  guard: WriteGuard,
  requestId: string,
  log: RequestLogger,
): { blocked: true; result: string } | { blocked: false } {
  if (guard.writesCount >= MAX_WRITES_PER_EXCHANGE) {
    log.info("hippocampus", "limit_exceeded", {
      meta: {
        exchange_id: requestId,
        writes_count: guard.writesCount,
        skipped_dup_count: guard.skippedDupCount,
      },
    });
    return {
      blocked: true,
      result: JSON.stringify({
        ok: false,
        error: { code: "limit_exceeded", message: "max 3 writes per exchange" },
      }),
    };
  }
  return { blocked: false };
}

export function bumpWriteCount(guard: WriteGuard): void {
  guard.writesCount++;
}

export function emitHippoTelemetry(
  guard: WriteGuard,
  requestId: string,
  steps: number,
  log: RequestLogger,
): void {
  incrementCounter("hippocampus_writes_per_exchange", {
    exchange_id: requestId,
    writes_count: String(guard.writesCount),
    skipped_dup_count: String(guard.skippedDupCount),
  });
  log.info("hippocampus", "exchange_complete", {
    meta: {
      exchange_id: requestId,
      writes_count: guard.writesCount,
      skipped_dup_count: guard.skippedDupCount,
      steps,
    },
  });
}
