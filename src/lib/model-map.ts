export const EMBED_MODEL = "nvidia/llama-3.2-nemoretriever-300m-embed-v1";
export const EMBED_CODE_MODEL = "nvidia/nv-embedcode-7b-v1";
export const RERANK_MODEL = "nvidia/rerank-qa-mistral-4b";

export type Priority = "critical" | "normal" | "low";
export type ProviderName =
  | "nvidia"
  | "openrouter"
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

// Per-role differentiation across NIM preview pool (verified 2026-05-03 на
// build.nvidia.com/models?filters=nimType%3Anim_type_preview). Shared 40 RPM
// limit на всех NVIDIA primaries — упор на quality, не throughput. MiniMax
// fallback везде где есть — общий пул на случай NIM 5xx / quota burst.
export const MODEL_MAP: Record<string, ModelRoute> = {
  // Teamlead = orchestrator. K2 Thinking: 1T MoE / 32B active, 256K ctx,
  // 200-300 sequential tool-calls без degradation, "Opus-flavored" в long
  // chains. MiniMax fallback тот же что у memory — единый пул.
  teamlead: {
    primary: "moonshotai/kimi-k2-thinking",
    primaryProvider: "nvidia",
    fallback: "MiniMax-M2.7",
    fallbackProvider: "minimax",
  },
  // Coder = чистая SWE-производительность. Qwen3-Coder-480b: SWE-Bench Pro
  // 38.7, Verified ~73.4 — лучший open-source coder на NIM. Devstral 2 как
  // fallback (SWE Verified 72.2, 256K ctx, agentic-tuned) — почти равная
  // производительность за дешевле.
  coder: {
    primary: "qwen/qwen3-coder-480b-a35b-instruct",
    primaryProvider: "nvidia",
    fallback: "mistralai/devstral-2-123b-instruct-2512",
    fallbackProvider: "nvidia",
  },
  // Critic = adversarial reviewer. GLM-4.7: HumanEval 94.2 + LiveCodeBench
  // 84.9 → отлично видит баги, edge-cases, scope-creep. K2 Thinking fallback
  // для adversarial reasoning chains.
  critic: {
    primary: "z-ai/glm-4.7",
    primaryProvider: "nvidia",
    fallback: "moonshotai/kimi-k2-thinking",
    fallbackProvider: "nvidia",
  },
  // Flash = быстрый tool-caller. Llama-4 Maverick 17B/128E: tool-calls
  // работают (в отличие от прошлого stepfun, который reasoning-only и клал
  // ответы в content вместо tool_calls). Maverick LiveCodeBench 43.4 —
  // слабый кодер, но flash для light tasks, не code.
  flash: {
    primary: "meta/llama-4-maverick-17b-128e-instruct",
    primaryProvider: "nvidia",
    fallback: "MiniMax-M2.7",
    fallbackProvider: "minimax",
  },
  // Chaos = провокатор-стратег. Swap 2026-05-03: Nemotron Ultra 253B (был
  // primary с предыдущего swap'а) оказался "конь, но не ёбнутый" — слишком
  // вылизанный instruction-tuned, не выдаёт чёрно-лебединого мнения. K2
  // Thinking creative + Opus-flavored, выдаёт неожиданные tool-loop стратегии.
  // Same model as teamlead — differentiation идёт через persona, не модель.
  chaos: {
    primary: "moonshotai/kimi-k2-thinking",
    primaryProvider: "nvidia",
    fallback: "MiniMax-M2.7",
    fallbackProvider: "minimax",
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
  // Memory subsystem (hippocampus + night-cycle). MiniMax-M2.7 via dedicated
  // minimax provider (platform.minimax.io). Reverted from gpt-5.1/openai-compat
  // 2026-04-28 after ChatGPT Plus quota burned (67h cooldown on Codex
  // credentials). NVIDIA mirror as emergency fallback — without it, transient
  // minimax 5xx/timeout breaks hippocampus and the chat falls back to a 35-char
  // salvage summary ("память сломалась"). Same model, different upstream.
  memory: {
    primary: "MiniMax-M2.7",
    primaryProvider: "minimax",
    fallback: "minimaxai/minimax-m2.7",
    fallbackProvider: "nvidia",
  },
};

/**
 * Allowlist for openai-compat (CLIProxyAPI bridge → ChatGPT Pro). Matches
 * gpt-5*, gpt-5.4-mini*, o3*, o4*, codex-*. Tighter regex breaks expected
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
  // Default: NVIDIA NIM. Per 2026-05-03 — все primaries сидят на NIM, а raw
  // model IDs из map'а (qwen/, meta/, moonshotai/, z-ai/) не матчат явные
  // префиксы выше. OpenRouter теперь только для explicit `openrouter/` или
  // `:free` суффикса; raw `claude-*`/`gpt-*`/`gemini-*` полетят в NIM и
  // упадут с 404 — это намеренно, других провайдеров пока не подключаем.
  return "nvidia";
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
