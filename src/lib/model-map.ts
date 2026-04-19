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
    primary: "gemini-3.1",
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
    primary: "mistralai/mistral-nemotron",
    primaryProvider: "nvidia",
    fallback: "gemini-2.0-flash-001",
    fallbackProvider: "copilot",
  },
  flash: {
    primary: "stepfun-ai/step-3.5-flash",
    primaryProvider: "nvidia",
    fallback: "gpt-4o-mini",
    fallbackProvider: "copilot",
  },
};

/** Detect provider from raw model ID. */
function detectProvider(model: string): ProviderName {
  if (model.endsWith(":free") || model.startsWith("openrouter/")) {
    return "openrouter";
  }
  // Copilot Pro models use bare names without org/ prefix
  const copilotModels = [
    "gpt-4o",
    "gpt-4o-mini",
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4.1-nano",
    "o3-mini",
    "o4-mini",
    "claude-sonnet-4",
    "claude-sonnet-4.6",
    "claude-haiku-3.5",
    "gemini-2.0-flash-001",
    "gemini-2.5-pro",
    "gemini-3.1",
  ];
  if (copilotModels.includes(model)) {
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
