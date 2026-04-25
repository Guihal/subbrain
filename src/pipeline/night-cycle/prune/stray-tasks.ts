/**
 * Night-cycle Step 12: collect stray task-like rows from shared_memory and
 * layer2_context that were written by older code / hippocampus before the
 * Phase-1 tasks table existed.
 *
 * Window is state-tracked via the `night.stray_tasks.last_run_at` focus key
 * (added to PROTECTED_FOCUS_KEYS so pruneFocus doesn't wipe it). First run
 * covers up to `MAX_WINDOW_SECONDS` (7 days). A skipped cycle therefore
 * backfills up to a week; longer outages silently drop older rows (Step 12
 * is advisory cleanup, not critical path).
 *
 * If the per-row loop or setFocus throws, the focus key is NOT advanced, so
 * the next successful cycle will re-scan the same window (idempotent on
 * migrate via `upsertTaskBySource` with `source="stray:<table>:<id>"`).
 */
import { randomUUID } from "crypto";
import type { MemoryDB } from "../../../db";
import { logger } from "../../../lib/logger";
import {
  type CandidateRow,
  type Classifier,
  classifyCandidate,
  hasBlacklistTag,
  hasCompletedStatusTag,
  hasTaskTag,
} from "./tasks-classify";

const log = logger.child("night.stray");
const MAX_WINDOW_SECONDS = 7 * 86400;
const MAX_PER_CYCLE = 20;
const MAX_DURATION_MS = 3 * 60 * 1000;
export const LAST_RUN_FOCUS_KEY = "night.stray_tasks.last_run_at";

interface SharedScanRow {
  id: string;
  category: string;
  content: string;
  tags: string;
}
interface ContextScanRow {
  id: string;
  title: string;
  content: string;
  tags: string;
  agent_id: string | null;
}

export async function collectStrayTasks(
  memory: MemoryDB,
  router: Classifier,
): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const lastRunRaw = memory.getFocus(LAST_RUN_FOCUS_KEY);
  const lastRun = lastRunRaw ? parseInt(lastRunRaw, 10) : NaN;
  const windowStart = Number.isFinite(lastRun)
    ? Math.max(now - MAX_WINDOW_SECONDS, lastRun)
    : now - MAX_WINDOW_SECONDS;

  const candidates: CandidateRow[] = [];
  const shared = memory.db
    .query(
      `SELECT id, category, content, tags FROM shared_memory
       WHERE created_at >= ?`,
    )
    .all(windowStart) as SharedScanRow[];
  for (const row of shared) {
    if (!hasTaskTag(row.tags)) continue;
    if (hasBlacklistTag(row.tags)) continue;
    if (hasCompletedStatusTag(row.tags)) continue;
    candidates.push({
      id: row.id,
      source_table: "shared_memory",
      content: row.content,
      tags: row.tags,
      category: row.category,
    });
  }
  const context = memory.db
    .query(
      `SELECT id, title, content, tags, agent_id FROM layer2_context
       WHERE created_at >= ?`,
    )
    .all(windowStart) as ContextScanRow[];
  for (const row of context) {
    if (!hasTaskTag(row.tags)) continue;
    if (hasBlacklistTag(row.tags)) continue;
    if (hasCompletedStatusTag(row.tags)) continue;
    candidates.push({
      id: row.id,
      source_table: "layer2_context",
      content: row.content,
      tags: row.tags,
      title: row.title,
      agent_id: row.agent_id,
    });
  }

  const startedAt = Date.now();
  let migrated = 0;
  let processed = 0;
  let capHit = false;

  for (const row of candidates) {
    if (processed >= MAX_PER_CYCLE) {
      capHit = true;
      break;
    }
    if (Date.now() - startedAt > MAX_DURATION_MS) {
      log.info(`time cap reached, migrated=${migrated}`);
      capHit = true;
      break;
    }
    processed += 1;

    let result;
    try {
      result = await classifyCandidate(router, row);
    } catch (err) {
      log.warn(
        `classify row=${row.id.slice(0, 8)} failed: ${(err as Error).message}`,
      );
      continue;
    }
    if (!result || result.action !== "migrate") continue;

    try {
      memory.transaction(() => {
        memory.upsertTaskBySource(
          `stray:${row.source_table}:${row.id}`,
          {
            scope: result.scope,
            title: result.title,
            description: result.description,
            priority: result.priority,
          },
          randomUUID(),
        );
        if (row.source_table === "shared_memory") {
          memory.deleteShared(row.id);
        } else {
          memory.deleteContext(row.id);
          memory.deleteEmbedding(row.id);
        }
      });
      migrated += 1;
      log.info(
        `migrated ${row.source_table}:${row.id.slice(0, 8)} scope=${result.scope}`,
      );
    } catch (err) {
      log.warn(
        `tx row=${row.id.slice(0, 8)} failed: ${(err as Error).message}`,
      );
    }
  }

  // Only advance the window when every candidate has been examined. If we
  // hit the per-cycle or time cap, leave lastRun untouched so the skipped
  // tail gets re-scanned next cycle (upsertTaskBySource is idempotent on
  // already-migrated rows via the stable `stray:` source).
  if (!capHit) {
    memory.setFocus(LAST_RUN_FOCUS_KEY, String(now));
  }
  return migrated;
}
