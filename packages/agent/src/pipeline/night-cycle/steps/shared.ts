import { logger } from "@subbrain/core/lib/logger";
import { resolveNightModel } from "../model";

/**
 * Virtual role used for all night-cycle LLM calls. Default is `sleep`
 * (DeepSeek V4 Flash via NIM, MiniMax-M2.7 fallback). Override
 * via NIGHT_CYCLE_MODEL env.
 */
export const NIGHT_MODEL = resolveNightModel();

export const nightLog = logger.child("night");
