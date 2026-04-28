/**
 * Night-cycle stale-task pruning: deletes `open` tasks idle >30d and
 * `in_progress` tasks idle >7d. Runs BEFORE pruneCompletedTasks so the
 * cancelled-cleanup pass downstream stays a no-op for these rows (they're
 * already gone).
 *
 * Why DELETE not CANCEL: stuck tasks accumulate from autonomous/free-agent
 * ingestion and have no audit value once abandoned. Soft-cancel + 1d wait
 * keeps trash visible an extra day for nothing.
 */
import type { MemoryDB } from "../../../db";
import { logger } from "../../../lib/logger";

const log = logger.child("night.prune");

const OPEN_STALE_SECONDS = 30 * 86400;
const INPROGRESS_STALE_SECONDS = 7 * 86400;

export interface StaleTasksResult {
  openDeleted: number;
  inProgressDeleted: number;
}

export function pruneStaleTasks(memory: MemoryDB): StaleTasksResult {
  const result: StaleTasksResult = {
    openDeleted: memory.deleteStaleTasksByStatus("open", OPEN_STALE_SECONDS),
    inProgressDeleted: memory.deleteStaleTasksByStatus(
      "in_progress",
      INPROGRESS_STALE_SECONDS,
    ),
  };
  if (result.openDeleted || result.inProgressDeleted) {
    log.info(
      `stale-tasks deleted: open=${result.openDeleted} (>30d) in_progress=${result.inProgressDeleted} (>7d)`,
    );
  }
  return result;
}
