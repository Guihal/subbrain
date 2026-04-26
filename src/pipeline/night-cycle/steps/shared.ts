import { logger } from "../../../lib/logger";

/**
 * Virtual role used for all night-cycle LLM calls. Default is `memory`
 * (gpt-5.1 via cliproxy → ChatGPT Pro, MiniMax-M2.7 fallback). Override
 * via NIGHT_CYCLE_MODEL env.
 */
export const NIGHT_MODEL = process.env.NIGHT_CYCLE_MODEL || "memory";

export const nightLog = logger.child("night");
