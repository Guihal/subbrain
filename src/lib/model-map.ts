export const EMBED_MODEL = "nvidia/llama-3.2-nemoretriever-300m-embed-v1";
export const EMBED_CODE_MODEL = "nvidia/nv-embedcode-7b-v1";
export const RERANK_MODEL = "nvidia/rerank-qa-mistral-4b";

export type Priority = "critical" | "normal" | "low";
export type ProviderName =
  | "nvidia"
  | "openrouter"
  | "copilot"
  | "minimax"
  | "openai-compat";

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
    primary: "MiniMax-M2.7",
    primaryProvider: "minimax",
    fallback: "minimaxai/minimax-m2.7",
    fallbackProvider: "nvidia",
  },
  coder: {
    primary: "MiniMax-M2.7",
    primaryProvider: "minimax",
    fallback: "mistralai/devstral-2-123b-instruct-2512",
    fallbackProvider: "nvidia",
  },
  critic: {
    primary: "MiniMax-M2.7",
    primaryProvider: "minimax",
    fallback: "moonshotai/kimi-k2-thinking",
    fallbackProvider: "nvidia",
  },
  flash: {
    primary: "MiniMax-M2.7",
    primaryProvider: "minimax",
    fallback: "stepfun-ai/step-3.5-flash",
    fallbackProvider: "nvidia",
  },
  chaos: {
    primary: "MiniMax-M2.7",
    primaryProvider: "minimax",
    fallback: "mistralai/mistral-medium-3-instruct",
    fallbackProvider: "nvidia",
  },
  // Generalist virtual role — broad-purpose default for dynamic_tools
  // (`create_tool`) when caller doesn't specify a model. Same fallback shape
  // as teamlead/coder. NOT in applyOpenAICompatOverrides hard-coded list
  // (["teamlead","coder"]) — primary stays at MiniMax-M2.7 even when
  // OPENAI_COMPAT_ENABLED=true.
  generalist: {
    primary: "MiniMax-M2.7",
    primaryProvider: "minimax",
    fallback: "minimaxai/minimax-m2.7",
    fallbackProvider: "nvidia",
  },
  // Memory subsystem (hippocampus + night-cycle). Primary GPT-5.1 via
  // CLIProxyAPI bridge → ChatGPT Pro. Fallback MiniMax-M2.7 (instruct,
  // reliable tool-calling). Used when OPENAI_COMPAT_ENABLED=true; if flag
  // off, applyOpenAICompatOverrides keeps primary as-is — gpt-5.1 will
  // route to copilot provider, which won't have it; rely on minimax fallback.
  memory: {
    primary: "gpt-5.1",
    primaryProvider: "openai-compat",
    fallback: "MiniMax-M2.7",
    fallbackProvider: "minimax",
  },
};

/**
 * Allowlist for openai-compat (CLIProxyAPI bridge → ChatGPT Pro). Matches
 * gpt-5*, gpt-5.5*, o3*, o4*, codex-*. Tighter regex breaks expected
 * matches; looser breaks `gpt-4o → copilot`. Do NOT widen.
 */
const OPENAI_COMPAT_PREFIXES =
  /^(gpt-5(?:[-.\d]|$)|o3(?:-|$)|o4(?:-|$)|codex-)/;

/** Detect provider from raw model ID. */
function detectProvider(model: string): ProviderName {
  if (
    process.env.OPENAI_COMPAT_ENABLED === "true" &&
    OPENAI_COMPAT_PREFIXES.test(model)
  ) {
    return "openai-compat";
  }
  if (model.endsWith(":free") || model.startsWith("openrouter/")) {
    return "openrouter";
  }
  // MiniMax API uses "MiniMax-*" model IDs (platform.minimax.io)
  if (model.startsWith("MiniMax-") || model.startsWith("abab")) {
    return "minimax";
  }
  // NVIDIA NIM models use org/model naming (e.g. nvidia/llama-...)
  if (
    model.startsWith("nvidia/") ||
    model.startsWith("mistralai/") ||
    model.startsWith("nv-mistralai/") ||
    model.startsWith("minimaxai/")
  ) {
    return "nvidia";
  }
  // Default: Copilot API (claude-*, gpt-*, gemini-*, etc.)
  return "copilot";
}

export { applyOpenAICompatOverrides } from "./model-map/openai-compat-overrides";

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
