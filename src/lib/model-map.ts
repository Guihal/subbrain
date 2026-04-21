export const EMBED_MODEL = "nvidia/llama-3.2-nemoretriever-300m-embed-v1";
export const RERANK_MODEL = "nvidia/rerank-qa-mistral-4b";

export type Priority = "critical" | "normal" | "low";
export type ProviderName = "nvidia" | "openrouter" | "copilot";

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
    primary: "minimaxai/minimax-m2.7",
    primaryProvider: "nvidia",
    fallback: "moonshotai/kimi-k2-thinking",
  },
  coder: {
    primary: "mistralai/devstral-2-123b-instruct-2512",
    fallback: "qwen/qwen3-coder-480b-a35b-instruct",
  },
  critic: {
    primary: "moonshotai/kimi-k2-thinking",
    fallback: "moonshotai/kimi-k2-instruct-0905",
  },
  flash: {
    primary: "stepfun-ai/step-3.5-flash",
  },
  chaos: {
    primary: "mistralai/mistral-medium-3-instruct",
  },
};

/** Detect provider from raw model ID. */
function detectProvider(model: string): ProviderName {
  if (model.endsWith(":free") || model.startsWith("openrouter/")) {
    return "openrouter";
  }
  // NVIDIA NIM models use org/model naming (e.g. nvidia/llama-...)
  if (
    model.startsWith("nvidia/") ||
    model.startsWith("mistralai/") ||
    model.startsWith("nv-mistralai/")
  ) {
    return "nvidia";
  }
  // Default: Copilot API (claude-*, gpt-*, gemini-*, etc.)
  return "copilot";
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
