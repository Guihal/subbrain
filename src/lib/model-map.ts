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
    primary: "moonshotai/kimi-k2-thinking",
    primaryProvider: "nvidia",
    fallback: "mistralai/mistral-large-3-675b-instruct-2512",
    fallbackProvider: "nvidia",
  },
  coder: {
    primary: "qwen/qwen3-coder-480b-a35b-instruct",
    primaryProvider: "nvidia",
    fallback: "mistralai/devstral-2-123b-instruct-2512",
    fallbackProvider: "nvidia",
  },
  critic: {
    primary: "mistralai/devstral-2-123b-instruct-2512",
    primaryProvider: "nvidia",
    fallback: "qwen/qwen3-coder-480b-a35b-instruct",
    fallbackProvider: "nvidia",
  },
  generalist: {
    primary: "mistralai/mistral-large-3-675b-instruct-2512",
    primaryProvider: "nvidia",
    fallback: "moonshotai/kimi-k2-thinking",
    fallbackProvider: "nvidia",
  },
  chaos: {
    primary: "mistralai/mistral-nemotron",
    primaryProvider: "nvidia",
    fallback: "mistralai/mistral-large-3-675b-instruct-2512",
    fallbackProvider: "nvidia",
  },
  flash: {
    primary: "stepfun-ai/step-3.5-flash",
    primaryProvider: "nvidia",
    fallback: "moonshotai/kimi-k2-thinking",
    fallbackProvider: "nvidia",
  },
};

/** Detect provider from raw model ID. */
function detectProvider(model: string): ProviderName {
  if (model.endsWith(":free") || model.startsWith("openrouter/")) {
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
