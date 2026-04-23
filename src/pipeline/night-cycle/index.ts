import { randomUUID } from "crypto";
import type { MemoryDB } from "../../db";
import type { ModelRouter } from "../../lib/model-router";
import type { RAGPipeline } from "../../rag";
import { logger } from "../../lib/logger";
import { getMoscowDate } from "../../lib/clock";

const log = logger.child("night");
import {
  type NightCycleResult,
  BATCH_SIZE,
  FOCUS_KEY_LAST_PROCESSED,
  buildConversationText,
} from "./types";
import {
  scrubPII,
  translate,
  compress,
  verify,
  dedup,
  extractAntiPatterns,
  resolveContradictions,
} from "./steps";
import { pruneShared, pruneContext, pruneFocus } from "./prune";

export type { NightCycleResult } from "./types";

// ─── PII-scrub retry queue ────────────────────────────
// Sessions whose scrubPII or translate failed are persisted here so the next
// cycle can re-fetch their raw_log entries via getLogsBySession and retry.
// When attempts reach MAX_ATTEMPTS the entry is dropped with an error log —
// the raw logs stay in layer4_log so a human can review / manually re-run.

const RETRY_FOCUS_KEY = "pii_scrub_retry_sessions";
const MAX_RETRY_QUEUE_SIZE = 100;
const MAX_PII_ATTEMPTS = (() => {
  const raw = process.env.NIGHT_CYCLE_PII_RETRY_MAX;
  if (!raw) return 3;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 3;
})();

interface RetryEntry {
  session_id: string;
  attempts: number;
  first_failed_at: number;
}

function parseRetryQueue(raw: string | null): RetryEntry[] {
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

function upsertRetry(queue: RetryEntry[], sessionId: string): RetryEntry[] {
  const existing = queue.find((e) => e.session_id === sessionId);
  if (existing) {
    existing.attempts += 1;
    return queue;
  }
  const next = [
    ...queue,
    { session_id: sessionId, attempts: 1, first_failed_at: Date.now() },
  ];
  if (next.length <= MAX_RETRY_QUEUE_SIZE) return next;
  return next
    .sort((a, b) => a.first_failed_at - b.first_failed_at)
    .slice(-MAX_RETRY_QUEUE_SIZE);
}

export class NightCycle {
  constructor(
    private memory: MemoryDB,
    private router: ModelRouter,
    private rag: RAGPipeline,
  ) {}

  /**
   * Run the full night cycle pipeline:
   * 1. PII detection & scrub
   * 2. Translation RU→EN
   * 3. Compression (Layer 4 → Layer 3)
   * 4. Verification
   * 5. Deduplication
   * 6. Anti-patterns
   * 7. Contradiction resolution
   */
  async run(): Promise<NightCycleResult> {
    const result: NightCycleResult = {
      processedLogs: 0,
      sessionsProcessed: 0,
      archiveEntriesCreated: 0,
      antiPatternsFound: 0,
      contradictionsResolved: 0,
      sharedPruned: 0,
      contextPruned: 0,
      focusPruned: 0,
      errors: [],
      lastProcessedId: 0,
    };

    const startedAt = Date.now();
    log.info("Cycle started");

    // Get last processed position
    const lastIdStr = this.memory.getFocus(FOCUS_KEY_LAST_PROCESSED);
    const lastProcessedId = lastIdStr ? parseInt(lastIdStr, 10) : 0;

    // Fetch unprocessed logs
    const logs = this.memory.getLogsSince(lastProcessedId, BATCH_SIZE);
    if (logs.length === 0) {
      log.info("No unprocessed logs — nothing to do");
      return result;
    }

    result.processedLogs = logs.length;
    result.lastProcessedId = logs[logs.length - 1].id;

    // Group by session
    const sessions = this.memory.groupLogsBySession(logs);
    result.sessionsProcessed = sessions.size;

    log.info(`Processing ${logs.length} logs across ${sessions.size} sessions (lastId: ${lastProcessedId} → ${result.lastProcessedId})`,
    );

    // ─── Retry pass: reprocess sessions whose PII-scrub failed earlier ──
    // Read queue, drop entries that exceeded MAX_PII_ATTEMPTS, retry the rest.
    // Survivors are persisted at end-of-run via setFocus.
    let retryQueue = parseRetryQueue(this.memory.getFocus(RETRY_FOCUS_KEY));
    if (retryQueue.length > 0) {
      log.info(`Retry pass: ${retryQueue.length} session(s) in pii_scrub_retry queue`);
    }
    const survivors: RetryEntry[] = [];
    let retryIdx = 0;
    const retryTotal = retryQueue.length;
    for (const entry of retryQueue) {
      retryIdx++;
      if (entry.attempts >= MAX_PII_ATTEMPTS) {
        log.error(
          `pii_scrub permanent fail session=${entry.session_id.slice(0, 8)} attempts=${entry.attempts}`,
        );
        result.errors.push(`PII permanent fail: ${entry.session_id}`);
        continue;
      }
      const sessionLogs = this.memory.getLogsBySession(entry.session_id, 1000);
      if (sessionLogs.length === 0) {
        log.warn(`Retry ${retryIdx}/${retryTotal}: session=${entry.session_id.slice(0, 8)} has no logs, dropping`);
        continue;
      }
      const ok = await this.processSession(
        entry.session_id,
        sessionLogs,
        `retry ${retryIdx}/${retryTotal}`,
        result,
      );
      if (!ok) {
        survivors.push({ ...entry, attempts: entry.attempts + 1 });
      }
    }
    retryQueue = survivors;

    // ─── Main batch: process new sessions ──────────────────────────────
    let sessionIdx = 0;
    for (const [sessionId, sessionLogs] of sessions) {
      sessionIdx++;
      const ok = await this.processSession(
        sessionId,
        sessionLogs,
        `${sessionIdx}/${sessions.size}`,
        result,
      );
      if (!ok) {
        retryQueue = upsertRetry(retryQueue, sessionId);
      }
    }

    // Persist retry queue (survivors from retry pass + new failures from main batch)
    this.memory.setFocus(RETRY_FOCUS_KEY, JSON.stringify(retryQueue));

    // Step 6: Anti-patterns
    log.info("Extracting anti-patterns…");
    try {
      const antiPatterns = await extractAntiPatterns(logs, this.router);
      if (antiPatterns) {
        const apId = randomUUID();
        try {
          const vec = await this.rag.embedContent(antiPatterns);
          this.memory.db.transaction(() => {
            this.memory.insertArchive(
              apId,
              "Anti-patterns: " + getMoscowDate(),
              antiPatterns,
              "anti-patterns,night-cycle",
              [],
              "HIGH",
              "night-cycle",
            );
            this.memory.upsertEmbedding(apId, "archive", vec);
          })();
          result.antiPatternsFound = 1;
        } catch (err) {
          log.warn(`anti-patterns_retry_next_cycle id=${apId} reason=${(err as Error).message}`);
        }
      }
    } catch (err) {
      const msg = (err as Error).message;
      log.error(`Anti-patterns failed: ${msg}`);
      result.errors.push(`Anti-patterns: ${msg}`);
    }

    // Step 7: Resolve contradictions
    log.info("Resolving contradictions…");
    try {
      const resolved = await resolveContradictions(this.memory, this.router, this.rag);
      result.contradictionsResolved = resolved;
    } catch (err) {
      const msg = (err as Error).message;
      log.error(`Resolve contradictions failed: ${msg}`);
      result.errors.push(`Resolve: ${msg}`);
    }

    // Step 8: Prune shared_memory
    log.info("Pruning shared_memory…");
    try {
      result.sharedPruned = await pruneShared(this.memory, this.router);
      log.info(`shared pruned=${result.sharedPruned}`);
    } catch (err) {
      const msg = (err as Error).message;
      log.error(`Prune shared failed: ${msg}`);
      result.errors.push(`Prune shared: ${msg}`);
    }

    // Step 9: Prune layer2_context
    log.info("Pruning layer2_context…");
    try {
      result.contextPruned = await pruneContext(this.memory, this.router, this.rag);
      log.info(`context pruned=${result.contextPruned}`);
    } catch (err) {
      const msg = (err as Error).message;
      log.error(`Prune context failed: ${msg}`);
      result.errors.push(`Prune context: ${msg}`);
    }

    // Step 10: Prune layer1_focus
    log.info("Pruning layer1_focus…");
    try {
      result.focusPruned = await pruneFocus(this.memory, this.router);
      log.info(`focus pruned=${result.focusPruned}`);
    } catch (err) {
      const msg = (err as Error).message;
      log.error(`Prune focus failed: ${msg}`);
      result.errors.push(`Prune focus: ${msg}`);
    }

    // Save progress
    this.memory.setFocus(
      FOCUS_KEY_LAST_PROCESSED,
      String(result.lastProcessedId),
    );

    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    log.info(`Cycle finished in ${elapsedSec}s — archived=${result.archiveEntriesCreated} antiPatterns=${result.antiPatternsFound} contradictions=${result.contradictionsResolved} sharedPruned=${result.sharedPruned} contextPruned=${result.contextPruned} focusPruned=${result.focusPruned} errors=${result.errors.length}`,
      { meta: { ...result } },
    );

    return result;
  }

  /**
   * Process one session through scrub → translate → compress → verify →
   * dedup → embed → archive. Returns `true` if the session reached a terminal
   * state (archived, deduped, skipped for size/empty-compress/embed-fail —
   * all not worth retrying), `false` only when scrub or translate returned
   * null (the caller enqueues the session_id for a future retry).
   */
  private async processSession(
    sessionId: string,
    sessionLogs: import("../../db").LogRow[],
    label: string,
    result: NightCycleResult,
  ): Promise<boolean> {
    try {
      const conversationText = buildConversationText(sessionLogs);
      if (conversationText.length < 50) {
        log.debug(`Session ${label} skipped (text < 50 chars)`);
        return true;
      }

      log.info(
        `[${label}] session=${sessionId.slice(0, 8)} chars=${conversationText.length}`,
      );

      const scrubbed = await scrubPII(conversationText, this.router);
      if (scrubbed === null) {
        log.warn(`[${label}] scrub_failed_skip session=${sessionId.slice(0, 8)}`);
        result.errors.push(`PII scrub failed: ${sessionId}`);
        return false;
      }

      const translated = await translate(scrubbed, this.router);
      if (translated === null) {
        log.warn(`[${label}] translate_failed_skip session=${sessionId.slice(0, 8)}`);
        result.errors.push(`Translate failed: ${sessionId}`);
        return false;
      }

      const requestIds = [...new Set(sessionLogs.map((l) => l.request_id))];
      const compressed = await compress(translated, requestIds, this.router);
      if (!compressed) {
        log.warn(`[${label}] compress returned empty — skipping`);
        return true;
      }

      const verified = await verify(compressed, translated, this.router);

      const isDuplicate = await dedup(verified, this.memory, this.router, this.rag);
      if (isDuplicate) {
        log.info(`[${label}] dedup hit — skipping`);
        return true;
      }

      const entryId = randomUUID();
      let vec: Float32Array;
      try {
        vec = await this.rag.embedContent(verified.content);
      } catch (err) {
        const msg = (err as Error).message;
        log.warn(`[${label}] archive_embed_fail_skip id=${entryId} reason=${msg}`);
        return true; // not a scrub failure; do not retry via queue
      }
      this.memory.db.transaction(() => {
        this.memory.insertArchive(
          entryId,
          verified.title,
          verified.content,
          verified.tags,
          verified.sourceRequestIds,
          verified.confidence,
          "night-cycle",
        );
        this.memory.upsertEmbedding(entryId, "archive", vec);
      })();
      result.archiveEntriesCreated++;
      log.info(`[${label}] archived "${verified.title.slice(0, 60)}"`);
      return true;
    } catch (err) {
      const msg = (err as Error).message;
      log.error(`[${label}] session ${sessionId.slice(0, 8)} failed: ${msg}`);
      result.errors.push(`Session ${sessionId}: ${msg}`);
      return true;
    }
  }
}
