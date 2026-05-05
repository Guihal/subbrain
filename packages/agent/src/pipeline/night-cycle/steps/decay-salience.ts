/**
 * M-03 (mig 13): night-cycle salience decay step. Pure SQL, no LLM.
 *
 * Per layer (shared / context / archive):
 *   salience := salience * 0.98 ^ days_since_last_decayed
 *   last_decayed_at := now
 *
 * The actual UPDATE lives in `MemoryRepository.decaySalience` so the SQL
 * stays inside the repository layer (boundary test). This file is the
 * orchestrator: pin `now`, fan out to 3 layers, log, return counts.
 *
 * Idempotency, floor, and proxy-to-last_accessed_at semantics are all
 * documented on the repository method.
 */
import type { MemoryDB } from "@subbrain/core/db";
import { logger } from "@subbrain/core/lib/logger";

const log = logger.child("night.decay-salience");

export interface DecaySalienceResult {
  shared: number;
  context: number;
  archive: number;
}

const LAYERS = ["shared", "context", "archive"] as const;

export async function decaySalience(memory: MemoryDB): Promise<DecaySalienceResult> {
  const now = Math.floor(Date.now() / 1000);
  const counts: DecaySalienceResult = { shared: 0, context: 0, archive: 0 };

  for (const layer of LAYERS) {
    counts[layer] = memory.memoryRepo.decaySalience(layer, now);
  }

  log.info(`done: shared=${counts.shared}, context=${counts.context}, archive=${counts.archive}`);
  return counts;
}
