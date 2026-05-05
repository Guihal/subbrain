/**
 * PR-B: Night janitor orchestrator.
 * Phase A — delete expired shared/context rows.
 * Phase B — cosine-dedup fresh pairs (≤7d), archive duplicates.
 * Phase C — legacy purge (JANITOR_LEGACY_SWEEP=true), archive unknown-category/oversize rows.
 * Phase D — delete done tasks older than 30 days.
 *
 * All phases isolated + independently unit-testable.
 */
import type { MemoryDB } from "@subbrain/core/db";
import { logger } from "@subbrain/core/lib/logger";
import type { RAGPipeline } from "../../../rag";
import type { Notifier } from "../../../telegram/bot/notify";
import { runPhaseA } from "./phase-a";
import { runPhaseB, runPhaseC } from "./phase-bc";
import { runPhaseD } from "./phase-d";

const log = logger.child("night.janitor");

export interface JanitorResult {
  expiredDeleted: number;
  dedupArchived: number;
  legacyArchived: number;
  doneTasksDeleted: number;
}

export async function runJanitor(
  memory: MemoryDB,
  rag: RAGPipeline,
  notifier?: Notifier,
): Promise<JanitorResult> {
  const result: JanitorResult = {
    expiredDeleted: 0,
    dedupArchived: 0,
    legacyArchived: 0,
    doneTasksDeleted: 0,
  };

  try {
    const a = runPhaseA(memory);
    result.expiredDeleted = a.sharedDeleted + a.contextDeleted;
  } catch (err) {
    log.error(`phase-A failed: ${String(err)}`);
  }

  try {
    const b = await runPhaseB(memory, rag);
    result.dedupArchived = b.dedupArchived;
  } catch (err) {
    log.error(`phase-B failed: ${String(err)}`);
  }

  try {
    const c = runPhaseC(memory);
    result.legacyArchived = c.legacyArchived;
    if (c.legacyArchived > 0 && notifier) {
      const date = new Date().toISOString().slice(0, 10);
      notifier
        .notify(
          `🧹 Janitor legacy sweep: archived ${c.legacyArchived} rows. ` +
            `Restore via POST /v1/memory/restore. ` +
            `Tag prefix: legacy-cleanup-${date}`,
        )
        .catch((e) => log.warn(`tg-notify-failed: ${String(e)}`));
    }
  } catch (err) {
    log.error(`phase-C failed: ${String(err)}`);
  }

  try {
    const d = runPhaseD(memory);
    result.doneTasksDeleted = d.doneTasksDeleted;
  } catch (err) {
    log.error(`phase-D failed: ${String(err)}`);
  }

  log.info(
    `done: expired=${result.expiredDeleted} dedup=${result.dedupArchived} legacy=${result.legacyArchived} tasks=${result.doneTasksDeleted}`,
  );
  return result;
}
