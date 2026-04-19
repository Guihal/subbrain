import { randomUUID } from "crypto";
import type { MemoryDB } from "../../db";
import type { ModelRouter } from "../../lib/model-router";
import type { RAGPipeline } from "../../rag";
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

    // Get last processed position
    const lastIdStr = this.memory.getFocus(FOCUS_KEY_LAST_PROCESSED);
    const lastProcessedId = lastIdStr ? parseInt(lastIdStr, 10) : 0;

    // Fetch unprocessed logs
    const logs = this.memory.getLogsSince(lastProcessedId, BATCH_SIZE);
    if (logs.length === 0) return result;

    result.processedLogs = logs.length;
    result.lastProcessedId = logs[logs.length - 1].id;

    // Group by session
    const sessions = this.memory.groupLogsBySession(logs);
    result.sessionsProcessed = sessions.size;

    // Process each session
    for (const [sessionId, sessionLogs] of sessions) {
      try {
        const conversationText = buildConversationText(sessionLogs);
        if (conversationText.length < 50) continue;

        const scrubbed = await scrubPII(conversationText, this.router);
        const translated = await translate(scrubbed, this.router);

        const requestIds = [...new Set(sessionLogs.map((l) => l.request_id))];
        const compressed = await compress(translated, requestIds, this.router);
        if (!compressed) continue;

        const verified = await verify(compressed, translated, this.router);

        const isDuplicate = await dedup(verified, this.memory, this.router);
        if (isDuplicate) continue;

        // Write to Layer 3
        const entryId = randomUUID();
        this.memory.insertArchive(
          entryId,
          verified.title,
          verified.content,
          verified.tags,
          verified.sourceRequestIds,
          verified.confidence,
          "night-cycle",
        );
        this.rag
          .indexEntry(entryId, "archive", verified.content)
          .catch(() => {});
        result.archiveEntriesCreated++;
      } catch (err) {
        result.errors.push(`Session ${sessionId}: ${(err as Error).message}`);
      }
    }

    // Step 6: Anti-patterns
    try {
      const antiPatterns = await extractAntiPatterns(logs, this.router);
      if (antiPatterns) {
        const apId = randomUUID();
        this.memory.insertArchive(
          apId,
          "Anti-patterns: " + new Date().toISOString().slice(0, 10),
          antiPatterns,
          "anti-patterns,night-cycle",
          [],
          "HIGH",
          "night-cycle",
        );
        this.rag.indexEntry(apId, "archive", antiPatterns).catch(() => {});
        result.antiPatternsFound = 1;
      }
    } catch (err) {
      result.errors.push(`Anti-patterns: ${(err as Error).message}`);
    }

    // Step 7: Resolve contradictions
    try {
      const resolved = await resolveContradictions(this.memory, this.router);
      result.contradictionsResolved = resolved;
    } catch (err) {
      result.errors.push(`Resolve: ${(err as Error).message}`);
    }

    // Save progress
    this.memory.setFocus(
      FOCUS_KEY_LAST_PROCESSED,
      String(result.lastProcessedId),
    );

    return result;
  }
}
