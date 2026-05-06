/**
 * Single source of truth for the night-cycle LLM model.
 *
 * Default virtual role is `sleep` (dedicated night-cycle role in MODEL_MAP).
 * Override via `NIGHT_CYCLE_MODEL` env.
 */
export function resolveNightModel(): string {
  return process.env.NIGHT_CYCLE_MODEL || "sleep";
}
