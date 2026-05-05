/**
 * PR-B Phase D — delete done tasks older than 30 days.
 * Extends the existing stale-task prune pass with a status-aware done-task
 * cleanup. Only touches the `tasks` table (NOT `agent_tasks` — PR-C territory).
 *
 * Uses MemoryDB.deleteDoneTasksOlderThan (Data layer facade) — no raw SQL here.
 */
import type { MemoryDB } from "@subbrain/core/db";
import { logger } from "@subbrain/core/lib/logger";

const log = logger.child("night.janitor");

const DONE_RETENTION_DAYS = 30;

export function runPhaseD(memory: MemoryDB): { doneTasksDeleted: number } {
  const ageSec = DONE_RETENTION_DAYS * 86400;
  const doneTasksDeleted = memory.deleteDoneTasksOlderThan(ageSec);

  if (doneTasksDeleted) {
    log.info(`phase-D done tasks deleted=${doneTasksDeleted} (>${DONE_RETENTION_DAYS}d)`);
  }
  return { doneTasksDeleted };
}
