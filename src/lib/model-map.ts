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
    primary: "anthropic/claude-sonnet-4.6",
    primaryProvider: "copilot",
    fallback: "openai/gpt-4o",
    fallbackProvider: "copilot",
  },
  coder: {
    primary: "anthropic/claude-sonnet-4.6",
    primaryProvider: "copilot",
    fallback: "openai/gpt-4o",
    fallbackProvider: "copilot",
  },
  critic: {
    primary: "google/gemini-3.1",
    primaryProvider: "copilot",
    fallback: "openai/gpt-4o",
    fallbackProvider: "copilot",
  },
  generalist: {
    primary: "anthropic/claude-sonnet-4.6",
    primaryProvider: "copilot",
    fallback: "openai/gpt-4o",
    fallbackProvider: "copilot",
  },
  chaos: {
    primary: "mistralai/mistral-nemotron",
    primaryProvider: "nvidia",
    fallback: "google/gemini-2.0-flash-001",
    fallbackProvider: "copilot",
  },
  flash: {
    primary: "stepfun-ai/step-3.5-flash",
    primaryProvider: "nvidia",
    fallback: "openai/gpt-4o-mini",
    fallbackProvider: "copilot",
  },
};

/** Detect provider from raw model ID. */
function detectProvider(model: string): ProviderName {
  if (model.endsWith(":free") || model.startsWith("openrouter/")) {
    return "openrouter";
  }
  // GitHub Models uses org/model naming
  if (
    model.startsWith("openai/") ||
    model.startsWith("anthropic/") ||
    model.startsWith("google/") ||
    model.startsWith("meta/") ||
    model.startsWith("deepseek/") ||
    model.startsWith("cohere/") ||
    model.startsWith("mistral/") ||
    model.startsWith("xai/")
  ) {
    return "copilot";
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
