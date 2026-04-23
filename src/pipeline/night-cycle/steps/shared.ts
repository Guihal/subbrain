import { logger } from "../../../lib/logger";

/**
 * Virtual role used for all night-cycle LLM calls. Default is `coder`
 * (devstral-2, NVIDIA, instruct/non-reasoning) — previous `flash`
 * (stepfun-3.5-flash) is a reasoning model that spent ~25s/call on
 * "thinking" even for mechanical tasks like PII scrubbing, stretching
 * a full cycle to 7+ hours. `coder` does the same work in 3–5s/call.
 *
 * Override via NIGHT_CYCLE_MODEL env.
 */
export const NIGHT_MODEL = process.env.NIGHT_CYCLE_MODEL || "coder";

export const nightLog = logger.child("night");
