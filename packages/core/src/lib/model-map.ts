export const EMBED_MODEL = "nvidia/llama-3.2-nemoretriever-300m-embed-v1";
export const EMBED_CODE_MODEL = "nvidia/nv-embedcode-7b-v1";
export const RERANK_MODEL = "nvidia/rerank-qa-mistral-4b";

export type Priority = "critical" | "normal" | "low";
export type ProviderName = "nvidia" | "openrouter" | "minimax" | "openai-compat";

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

// Per-role swap 2026-05-04. NIM free-tier verified live: glm-5.1, kimi-k2.6,
// deepseek-v4-flash, llama-3.3-nemotron-super-49b-v1.5 — все HTTP 200 + tool_calls
// shape OpenAI-compat. v4-pro listed но hosted endpoint мёртвый (timeout 180s).
// Pre-deprecation rotation: kimi-k2-thinking (10d), devstral-2 (9d), glm-4.7
// (free но deprioritized) сняты с primary везде.
export const MODEL_MAP: Record<string, ModelRoute> = {
  // Teamlead = orchestrator. GLM-5.1 754B MoE / 131K ctx — гигаумный, SOTA на
  // agentic бенчах (SWE-Bench Pro 58.4, Terminal-Bench 69, MCP-Atlas 71.8,
  // BrowseComp 79.3). ⚠️ TTFT 20-30s cold (vLLM warmup на GB200). MiniMax
  // fallback на случай NIM 5xx / quota burst.
  teamlead: {
    primary: "z-ai/glm-5.1",
    primaryProvider: "nvidia",
    fallback: "MiniMax-M2.7",
    fallbackProvider: "minimax",
  },
  // Coder = быстрая итерация. DeepSeek V4 Flash 284B MoE / 1M ctx — fast
  // tool-calls (verified live). Qwen3-Coder-480b fallback как SWE specialty
  // (Verified ~73.4) на случай v4-flash 5xx.
  coder: {
    primary: "deepseek-ai/deepseek-v4-flash",
    primaryProvider: "nvidia",
    fallback: "qwen/qwen3-coder-480b-a35b-instruct",
    fallbackProvider: "nvidia",
  },
  // Critic = adversarial reviewer. GLM-5.1 strict win over 4.7 на reasoning +
  // coding бенчах (тот же endpoint, drop-in upgrade). MiniMax fallback на
  // случай NIM перегрузки.
  critic: {
    primary: "z-ai/glm-5.1",
    primaryProvider: "nvidia",
    fallback: "MiniMax-M2.7",
    fallbackProvider: "minimax",
  },
  // Flash = быстрый tool-caller для compressor / light tasks. Llama-4 Maverick
  // 17B/128E: tool-calls работают, dense-like latency. Не code-tuned — чисто
  // helper для compress/translate.
  flash: {
    primary: "meta/llama-4-maverick-17b-128e-instruct",
    primaryProvider: "nvidia",
    fallback: "MiniMax-M2.7",
    fallbackProvider: "minimax",
  },
  // Chaos = провокатор-стратег. Kimi K2.6: 1T MoE multimodal, наследник
  // k2-thinking (deprecated 10d). Long-horizon coding + agentic tool use,
  // creative + Opus-flavored. Differentiation от teamlead через persona.
  chaos: {
    primary: "moonshotai/kimi-k2.6",
    primaryProvider: "nvidia",
    fallback: "MiniMax-M2.7",
    fallbackProvider: "minimax",
  },
  // Generalist = broad-purpose default для dynamic_tools (`create_tool`).
  // Llama-3.3 Nemotron Super 49B dense — NVIDIA-tuned reasoning + tool-call,
  // без MoE-routing-перегруза. NOT в applyOpenAICompatOverrides hard-coded
  // списке.
  generalist: {
    primary: "nvidia/llama-3.3-nemotron-super-49b-v1.5",
    primaryProvider: "nvidia",
    fallback: "MiniMax-M2.7",
    fallbackProvider: "minimax",
  },
  // Memory subsystem (hippocampus + night-cycle). DeepSeek V4 Flash: fast
  // tool-calls (verified) → low overhead на post-extraction после каждого
  // exchange. 1M ctx запас для night-cycle batch. MiniMax fallback на случай
  // NIM 5xx — без него transient breaks hippocampus в 35-char salvage.
  memory: {
    primary: "deepseek-ai/deepseek-v4-flash",
    primaryProvider: "nvidia",
    fallback: "MiniMax-M2.7",
    fallbackProvider: "minimax",
  },
  // Sleep = dedicated night-cycle role. Same fast model as memory, but
  // distinct virtual name so NIGHT_CYCLE_MODEL can target it independently.
  sleep: {
    primary: "deepseek-ai/deepseek-v4-flash",
    primaryProvider: "nvidia",
    fallback: "MiniMax-M2.7",
    fallbackProvider: "minimax",
  },
};

/**
 * Allowlist for openai-compat (CLIProxyAPI bridge → ChatGPT Pro). Matches
 * gpt-5*, gpt-5.4-mini*, o3*, o4*, codex-*. Tighter regex breaks expected
 * matches; looser breaks `gpt-4o → copilot`. Do NOT widen.
 */
const OPENAI_COMPAT_PREFIXES = /^(gpt-5(?:[-.\d]|$)|o3(?:-|$)|o4(?:-|$)|codex-)/;

/** Detect provider from raw model ID. */
function detectProvider(model: string): ProviderName {
  if (process.env.OPENAI_COMPAT_ENABLED === "true" && OPENAI_COMPAT_PREFIXES.test(model)) {
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
