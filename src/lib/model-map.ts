export type Priority = "critical" | "normal" | "low";
export type ProviderName = "nvidia" | "openrouter";

export interface ModelTarget {
  model: string;
  provider: ProviderName;
}

export interface ModelRoute {
  primary: string;
  primaryProvider?: ProviderName;
  fallback?: string;
  fallbackProvider?: ProviderName;
}

/** Maps virtual role names to actual model IDs with provider + fallbacks */
export const MODEL_MAP: Record<string, ModelRoute> = {
  teamlead: {
    primary: "moonshotai/kimi-k2.5",
    primaryProvider: "openrouter",
    fallback: "nvidia/nemotron-3-super-120b-a12b:free",
    fallbackProvider: "openrouter",
  },
  coder: {
    primary: "openrouter/elephant-alpha",
    primaryProvider: "openrouter",
    fallback: "minimax/minimax-m2.5:free",
    fallbackProvider: "openrouter",
  },
  critic: {
    primary: "nvidia/nemotron-3-super-120b-a12b:free",
    primaryProvider: "openrouter",
    fallback: "google/gemma-4-31b-it:free",
    fallbackProvider: "openrouter",
  },
  generalist: {
    primary: "minimax/minimax-m2.5:free",
    primaryProvider: "openrouter",
    fallback: "google/gemma-4-31b-it:free",
    fallbackProvider: "openrouter",
  },
  flash: {
    primary: "google/gemma-4-26b-a4b-it:free",
    primaryProvider: "openrouter",
    fallback: "google/gemma-4-31b-it:free",
    fallbackProvider: "openrouter",
  },
};

const OPENROUTER_MODEL_IDS = new Set([
  "moonshotai/kimi-k2.5",
  "openrouter/elephant-alpha",
  "minimax/minimax-m2.5",
  "google/gemma-4-26b-a4b-it",
  "google/gemma-4-31b-it",
  "nvidia/nemotron-3-super-120b-a12b",
]);

/** Detect provider from raw model ID. */
function detectProvider(model: string): ProviderName {
  if (
    model.endsWith(":free") ||
    model.startsWith("openrouter/") ||
    OPENROUTER_MODEL_IDS.has(model)
  ) {
    return "openrouter";
  }
  return "nvidia";
}

/** Resolves a virtual model name to the real model + provider */
export function resolveModel(model: string): ModelTarget {
  const route = MODEL_MAP[model];
  if (route) {
    return {
      model: route.primary,
      provider: route.primaryProvider ?? "nvidia",
    };
  }
  return { model, provider: detectProvider(model) };
}

/** Returns fallback model + provider for a virtual name, or null */
export function getFallback(model: string): ModelTarget | null {
  const route = MODEL_MAP[model];
  if (route?.fallback) {
    return {
      model: route.fallback,
      provider: route.fallbackProvider ?? "nvidia",
    };
  }
  return null;
}
