import type { LLMProvider } from "../../providers/types";
import type { RateLimiter } from "../rate-limiter";
import type { ProviderName } from "../model-map";

/** Hard timeout for any single provider call (ms) */
export const REQUEST_TIMEOUT = 60_000;

/** Cap on fallback model switches per chat() call. */
export const MAX_FALLBACK_ATTEMPTS = 1;

/** RPM limits per provider */
export const PROVIDER_RPM: Record<ProviderName, number> = {
  nvidia: 40,
  openrouter: 200,
  copilot: 10,
  // Token Plan quota = 1500 req / 5h ≈ 5 RPM sustained; cap at 20 to absorb bursts.
  minimax: 20,
};

export interface Backend {
  provider: LLMProvider;
  limiter: RateLimiter;
}
