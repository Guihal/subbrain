/**
 * Retry-pass + main-batch loops over `processSession` (H-2 split). Kept
 * separate from `retry-queue.ts` (pure helpers) to avoid a cycle with
 * `process-session.ts`.
 */
import type { LogRow, MemoryDB } from "@subbrain/core/db";
import { logger } from "@subbrain/core/lib/logger";
import type { ModelRouter } from "@subbrain/core/lib/model-router";
import type { RAGPipeline } from "../../rag";
import { processSession } from "./process-session";
import {
  MAX_PII_ATTEMPTS,
  parseRetryQueue,
  RETRY_FOCUS_KEY,
  type RetryEntry,
  upsertRetry,
} from "./retry-queue";
import type { NightCycleResult } from "./types";

const log = logger.child("night.batch");

interface Deps {
  memory: MemoryDB;
  router: ModelRouter;
  rag: RAGPipeline;
}

export async function runRetryPass(deps: Deps, result: NightCycleResult): Promise<RetryEntry[]> {
  const queue = parseRetryQueue(deps.memory.getFocus(RETRY_FOCUS_KEY));
  if (queue.length > 0) {
    log.info(`Retry pass: ${queue.length} session(s) in queue`);
  }
  const survivors: RetryEntry[] = [];
  let idx = 0;
  for (const entry of queue) {
    idx++;
    if (entry.attempts >= MAX_PII_ATTEMPTS) {
      log.error(
        `pii_scrub permanent fail session=${entry.session_id.slice(0, 8)} attempts=${entry.attempts}`,
      );
      result.errors.push(`PII permanent fail: ${entry.session_id}`);
      continue;
    }
    const sessionLogs = deps.memory.getLogsBySession(entry.session_id, 1000);
    if (sessionLogs.length === 0) continue;
    const ok = await processSession(
      deps,
      entry.session_id,
      sessionLogs,
      `retry ${idx}/${queue.length}`,
      result,
    );
    if (!ok) survivors.push({ ...entry, attempts: entry.attempts + 1 });
  }
  return survivors;
}

export async function runMainBatch(
  deps: Deps,
  sessions: Map<string, LogRow[]>,
  initialQueue: RetryEntry[],
  result: NightCycleResult,
): Promise<RetryEntry[]> {
  let queue = initialQueue;
  let idx = 0;
  for (const [sessionId, sessionLogs] of sessions) {
    idx++;
    const ok = await processSession(
      deps,
      sessionId,
      sessionLogs,
      `${idx}/${sessions.size}`,
      result,
    );
    if (!ok) queue = upsertRetry(queue, sessionId);
  }
  return queue;
}
