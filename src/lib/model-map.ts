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
    primary: "stepfun-ai/step-3.5-flash",
    primaryProvider: "nvidia",
  },
  coder: {
    primary: "stepfun-ai/step-3.5-flash",
    primaryProvider: "nvidia",
  },
  critic: {
    primary: "stepfun-ai/step-3.5-flash",
    primaryProvider: "nvidia",
  },
  generalist: {
    primary: "stepfun-ai/step-3.5-flash",
    primaryProvider: "nvidia",
  },
  chaos: {
    primary: "stepfun-ai/step-3.5-flash",
    primaryProvider: "nvidia",
  },
  flash: {
    primary: "stepfun-ai/step-3.5-flash",
    primaryProvider: "nvidia",
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
