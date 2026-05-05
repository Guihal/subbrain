/**
 * Tunables for the stray-task collector (Step 12 of the night cycle).
 *
 * Kept in a dedicated module so the orchestrator (`./index.ts`) can stay
 * compositional and the helpers (`./fetch.ts`, `./classify.ts`) can pull
 * caps without importing the orchestrator.
 */

/** Focus key stamped on every successful cycle; protected from prune. */
export const LAST_RUN_FOCUS_KEY = "night.stray_tasks.last_run_at";

/** Maximum lookback window when no prior run is recorded (7 days). */
export const MAX_WINDOW_SECONDS = 7 * 86400;

/** Per-cycle hard cap on processed candidates. */
export const MAX_PER_CYCLE = 20;

/** Per-cycle wall-clock budget (3 minutes) before bailing out. */
export const MAX_DURATION_MS = 3 * 60 * 1000;
