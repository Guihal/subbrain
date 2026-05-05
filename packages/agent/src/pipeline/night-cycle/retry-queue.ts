/**
 * PII-scrub retry queue (H-2 split from index.ts).
 *
 * Sessions whose `scrubPII` or `translate` failed are persisted in
 * `layer1_focus[RETRY_FOCUS_KEY]` so the next cycle can re-fetch their
 * raw_log entries and retry. After `MAX_PII_ATTEMPTS` the entry is dropped
 * with an error log; the raw logs stay in `layer4_log` so a human can
 * review / manually re-run.
 */
import { logger } from "@subbrain/core/lib/logger";

const log = logger.child("night.retry");

export const RETRY_FOCUS_KEY = "pii_scrub_retry_sessions";
export const MAX_RETRY_QUEUE_SIZE = 100;
export const MAX_PII_ATTEMPTS = (() => {
  const raw = process.env.NIGHT_CYCLE_PII_RETRY_MAX;
  if (!raw) return 3;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 3;
})();

export interface RetryEntry {
  session_id: string;
  attempts: number;
  first_failed_at: number;
}

export function parseRetryQueue(raw: string | null): RetryEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is RetryEntry =>
        !!e &&
        typeof e.session_id === "string" &&
        Number.isFinite(e.attempts) &&
        Number.isFinite(e.first_failed_at),
    );
  } catch {
    log.warn("retry queue JSON malformed, resetting to []");
    return [];
  }
}

export function upsertRetry(queue: RetryEntry[], sessionId: string): RetryEntry[] {
  const existing = queue.find((e) => e.session_id === sessionId);
  if (existing) {
    existing.attempts += 1;
    return queue;
  }
  const next = [...queue, { session_id: sessionId, attempts: 1, first_failed_at: Date.now() }];
  if (next.length <= MAX_RETRY_QUEUE_SIZE) return next;
  return next.sort((a, b) => a.first_failed_at - b.first_failed_at).slice(-MAX_RETRY_QUEUE_SIZE);
}
