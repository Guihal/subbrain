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
    primary: "moonshotai/kimi-k2-thinking",
    primaryProvider: "nvidia",
    fallback: "openai/gpt-4.1",
    fallbackProvider: "copilot",
  },
  coder: {
    primary: "qwen/qwen3-coder-480b-a35b-instruct",
    primaryProvider: "nvidia",
    fallback: "openai/gpt-4.1",
    fallbackProvider: "copilot",
  },
  critic: {
    primary: "mistralai/devstral-2-123b-instruct-2512",
    primaryProvider: "nvidia",
    fallback: "deepseek/DeepSeek-R1",
    fallbackProvider: "copilot",
  },
  generalist: {
    primary: "mistralai/mistral-large-3-675b-instruct-2512",
    primaryProvider: "nvidia",
    fallback: "openai/gpt-4.1",
    fallbackProvider: "copilot",
  },
  chaos: {
    primary: "mistralai/mistral-nemotron",
    primaryProvider: "nvidia",
    fallback: "meta/llama-4-maverick-17b-128e-instruct",
    fallbackProvider: "copilot",
  },
  flash: {
    primary: "stepfun-ai/step-3.5-flash",
    primaryProvider: "nvidia",
    fallback: "openai/gpt-4.1-mini",
    fallbackProvider: "copilot",
  },
};

/** Detect provider from raw model ID. */
function detectProvider(model: string): ProviderName {
  if (model.endsWith(":free") || model.startsWith("openrouter/")) {
    return "openrouter";
  }
  // GitHub Models uses org/model naming like openai/gpt-4.1, meta/llama-4-*
  if (
    model.startsWith("openai/") ||
    model.startsWith("meta/") ||
    model.startsWith("deepseek/") ||
    model.startsWith("cohere/") ||
    model.startsWith("mistral/") ||
    model.startsWith("github/")
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
