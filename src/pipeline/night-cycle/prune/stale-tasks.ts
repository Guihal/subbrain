/**
 * Night-cycle stale-task pruning: deletes `open` tasks idle >N days and
 * `in_progress` tasks idle >M days. Runs BEFORE pruneCompletedTasks so the
 * cancelled-cleanup pass downstream stays a no-op for these rows (they're
 * already gone).
 *
 * Why DELETE not CANCEL: stuck tasks accumulate from autonomous/free-agent
 * ingestion and have no audit value once abandoned. Soft-cancel + 1d wait
 * keeps trash visible an extra day for nothing.
 *
 * Defaults are aggressive (3d/3d) — autonomous + free-agent ingest dozens
 * of "tasks" per day that nobody actually picks up; an idle open task is
 * almost always abandoned. Override via NIGHT_CYCLE_STALE_OPEN_DAYS /
 * NIGHT_CYCLE_STALE_INPROGRESS_DAYS.
 */
import type { MemoryDB } from "../../../db";
import { logger } from "../../../lib/logger";

const log = logger.child("night.prune");

function envDays(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export interface StaleTasksResult {
  openDeleted: number;
  inProgressDeleted: number;
}

export function pruneStaleTasks(memory: MemoryDB): StaleTasksResult {
  const openDays = envDays("NIGHT_CYCLE_STALE_OPEN_DAYS", 3);
  const inProgressDays = envDays("NIGHT_CYCLE_STALE_INPROGRESS_DAYS", 3);
  const result: StaleTasksResult = {
    openDeleted: memory.deleteStaleTasksByStatus("open", openDays * 86400),
    inProgressDeleted: memory.deleteStaleTasksByStatus(
      "in_progress",
      inProgressDays * 86400,
    ),
  };
  if (result.openDeleted || result.inProgressDeleted) {
    log.info(
      `stale-tasks deleted: open=${result.openDeleted} (>${openDays}d) in_progress=${result.inProgressDeleted} (>${inProgressDays}d)`,
    );
  }
  return result;
}
