import type { LLMProvider } from "../../providers/types";
import type { RateLimiter } from "../rate-limiter";
import type { ProviderName } from "../model-map";

/** Hard timeout for any single provider call (ms). Must accommodate reasoning
 * fallback models (`minimaxai/minimax-m2.7`, `kimi-k2-thinking`) that spend
 * 30-90s on `reasoning_content` before the first visible token. Provider-level
 * timeouts (NVIDIA non-stream = 240s) are the real ceiling; this is the
 * router-level guard. */
export const REQUEST_TIMEOUT = 240_000;

/** Cap on fallback model switches per chat() call. */
export const MAX_FALLBACK_ATTEMPTS = 1;

/** RPM limits per provider */
export const PROVIDER_RPM: Record<ProviderName, number> = {
  nvidia: 40,
  openrouter: 200,
  // Token Plan quota = 1500 req / 5h ≈ 5 RPM sustained; cap at 20 to absorb bursts.
  minimax: 20,
  // CLIProxyAPI is local. Real bottleneck is ChatGPT Pro upstream RPM
  // (undocumented). 30 = conservative; raise after 1 week without 429.
  "openai-compat": 30,
};

export interface Backend {
  provider: LLMProvider;
  limiter: RateLimiter;
}
