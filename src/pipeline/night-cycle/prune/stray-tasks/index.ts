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
import type { MemoryDB } from "../../../../db";
import type { Classifier } from "../tasks-classify";
import { classifyAndUpsert } from "./classify";
import { LAST_RUN_FOCUS_KEY, MAX_WINDOW_SECONDS } from "./constants";
import { fetchCandidates } from "./fetch";

export { LAST_RUN_FOCUS_KEY } from "./constants";

export async function collectStrayTasks(memory: MemoryDB, router: Classifier): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const lastRunRaw = memory.getFocus(LAST_RUN_FOCUS_KEY);
  const lastRun = lastRunRaw ? Number.parseInt(lastRunRaw, 10) : Number.NaN;
  const windowStart = Number.isFinite(lastRun)
    ? Math.max(now - MAX_WINDOW_SECONDS, lastRun)
    : now - MAX_WINDOW_SECONDS;

  const candidates = fetchCandidates(memory, windowStart);
  const { migrated, capHit } = await classifyAndUpsert(memory, router, candidates);

  // Only advance the window when every candidate has been examined. If we
  // hit the per-cycle or time cap, leave lastRun untouched so the skipped
  // tail gets re-scanned next cycle (upsertTaskBySource is idempotent on
  // already-migrated rows via the stable `stray:` source).
  if (!capHit) {
    memory.setFocus(LAST_RUN_FOCUS_KEY, String(now));
  }
  return migrated;
}
