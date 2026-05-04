/**
 * PR-B Phase A — delete expired rows from shared_memory and layer2_context.
 * Rows with expires_at IS NOT NULL AND expires_at < now() are expired.
 * Returns total deleted count.
 *
 * Calls MemoryDB facade methods (Data layer) — no raw SQL in pipeline.
 */
import type { MemoryDB } from "../../../db";
import { logger } from "../../../lib/logger";

const log = logger.child("night.janitor");

export interface PhaseAResult {
  sharedDeleted: number;
  contextDeleted: number;
}

export function runPhaseA(memory: MemoryDB): PhaseAResult {
  const now = Math.floor(Date.now() / 1000);

  const sharedDeleted = memory.deleteExpiredShared(now);
  const contextDeleted = memory.deleteExpiredContext(now);

  if (sharedDeleted || contextDeleted) {
    log.info(`phase-A expired: shared=${sharedDeleted} context=${contextDeleted}`);
  }
  return { sharedDeleted, contextDeleted };
}
