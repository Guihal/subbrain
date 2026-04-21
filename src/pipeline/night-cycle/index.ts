import { randomUUID } from "crypto";
import type { MemoryDB } from "../../db";
import type { ModelRouter } from "../../lib/model-router";
import type { RAGPipeline } from "../../rag";
import { logger } from "../../lib/logger";

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

export type { NightCycleResult } from "./types";

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

    // Process each session
    let sessionIdx = 0;
    for (const [sessionId, sessionLogs] of sessions) {
      sessionIdx++;
      try {
        const conversationText = buildConversationText(sessionLogs);
        if (conversationText.length < 50) {
          log.debug(`Session ${sessionIdx}/${sessions.size} skipped (text < 50 chars)`,
          );
          continue;
        }

        log.info(`[${sessionIdx}/${sessions.size}] session=${sessionId.slice(0, 8)} chars=${conversationText.length}`,
        );

        const scrubbed = await scrubPII(conversationText, this.router);
        const translated = await translate(scrubbed, this.router);

        const requestIds = [...new Set(sessionLogs.map((l) => l.request_id))];
        const compressed = await compress(translated, requestIds, this.router);
        if (!compressed) {
          log.warn(`[${sessionIdx}/${sessions.size}] compress returned empty — skipping`,
          );
          continue;
        }

        const verified = await verify(compressed, translated, this.router);

        const isDuplicate = await dedup(verified, this.memory, this.router, this.rag);
        if (isDuplicate) {
          log.info(`[${sessionIdx}/${sessions.size}] dedup hit — skipping`,
          );
          continue;
        }

        // Write to Layer 3 — embed first, then archive + vector atomically.
        // If embed fails we skip the archive entirely rather than leave a NULL-vector
        // row that's invisible to RAG. Same session data is compressed again next cycle.
        const entryId = randomUUID();
        let vec: Float32Array;
        try {
          vec = await this.rag.embedContent(verified.content);
        } catch (err) {
          const msg = (err as Error).message;
          log.warn(`[${sessionIdx}/${sessions.size}] archive_retry_next_cycle id=${entryId} reason=${msg}`);
          continue;
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
        log.info(`[${sessionIdx}/${sessions.size}] archived "${verified.title.slice(0, 60)}"`,
        );
      } catch (err) {
        const msg = (err as Error).message;
        log.error(`[${sessionIdx}/${sessions.size}] session ${sessionId.slice(0, 8)} failed: ${msg}`,
        );
        result.errors.push(`Session ${sessionId}: ${msg}`);
      }
    }

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
              "Anti-patterns: " + new Date().toISOString().slice(0, 10),
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

    // Save progress
    this.memory.setFocus(
      FOCUS_KEY_LAST_PROCESSED,
      String(result.lastProcessedId),
    );

    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    log.info(`Cycle finished in ${elapsedSec}s — archived=${result.archiveEntriesCreated} antiPatterns=${result.antiPatternsFound} contradictions=${result.contradictionsResolved} errors=${result.errors.length}`,
      { meta: { ...result } },
    );

    return result;
  }
}
