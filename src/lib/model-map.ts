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
    primary: "claude-sonnet-4.6",
    primaryProvider: "copilot",
    fallback: "gpt-4o",
    fallbackProvider: "copilot",
  },
  coder: {
    primary: "claude-sonnet-4.6",
    primaryProvider: "copilot",
    fallback: "gpt-4o",
    fallbackProvider: "copilot",
  },
  critic: {
    primary: "gemini-3.1-pro-preview",
    primaryProvider: "copilot",
    fallback: "gpt-4o",
    fallbackProvider: "copilot",
  },
  generalist: {
    primary: "claude-sonnet-4.6",
    primaryProvider: "copilot",
    fallback: "gpt-4o",
    fallbackProvider: "copilot",
  },
  chaos: {
    primary: "gpt-5.4-mini",
    primaryProvider: "copilot",
    fallback: "gemini-3-flash-preview",
    fallbackProvider: "copilot",
  },
  flash: {
    primary: "gpt-5.4-mini",
    primaryProvider: "copilot",
    fallback: "gpt-4o-mini",
    fallbackProvider: "copilot",
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
