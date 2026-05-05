/**
 * Anti-patterns step (H-2 split): extract → embed → archive in one place.
 * `steps/anti-patterns.ts` only does the LLM extraction; this wrapper
 * adds the embed + transactional archive write.
 */
import { randomUUID } from "node:crypto";
import type { LogRow, MemoryDB } from "../../db";
import { getMoscowDate } from "../../lib/clock";
import { logger } from "../../lib/logger";
import type { ModelRouter } from "../../lib/model-router";
import type { RAGPipeline } from "../../rag";
import { extractAntiPatterns } from "./steps";
import type { NightCycleResult } from "./types";

const log = logger.child("night.anti");

export async function runAntiPatternsStep(
  deps: { memory: MemoryDB; router: ModelRouter; rag: RAGPipeline },
  logs: LogRow[],
  result: NightCycleResult,
): Promise<void> {
  const { memory, router, rag } = deps;
  log.info("Extracting anti-patterns…");
  try {
    const antiPatterns = await extractAntiPatterns(logs, router);
    if (!antiPatterns) return;
    const apId = randomUUID();
    try {
      const vec = await rag.embedContent(antiPatterns);
      // M-12 (mig 15): confidence is REAL [0..1]. 0.9 = legacy "HIGH" mapping.
      memory.transaction(() => {
        memory.insertArchive(
          apId,
          `Anti-patterns: ${getMoscowDate()}`,
          antiPatterns,
          "anti-patterns,night-cycle",
          [],
          0.9,
          "night-cycle",
        );
        memory.upsertEmbedding(apId, "archive", vec);
      });
      result.antiPatternsFound = 1;
    } catch (err) {
      log.warn(`anti-patterns_retry_next_cycle id=${apId} reason=${(err as Error).message}`);
    }
  } catch (err) {
    const msg = (err as Error).message;
    log.error(`Anti-patterns failed: ${msg}`);
    result.errors.push(`Anti-patterns: ${msg}`);
  }
}
