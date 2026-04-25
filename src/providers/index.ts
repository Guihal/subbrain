import type {
  LLMProvider,
  ChatParams,
  ChatResponse,
  EmbedResponse,
  RerankResponse,
  ModelInfo,
} from "./types";
import { NvidiaProvider } from "./nvidia";
import { CopilotProvider } from "./copilot";
import { MiniMaxProvider } from "./minimax";
import { OpenAICompatProvider } from "./openai-compat";
import { MODEL_MAP, type ProviderName } from "../lib/model-map";

export type { LLMProvider } from "./types";
export { ProviderError } from "./nvidia";

/** Create a single NVIDIA provider (legacy, for embed/rerank) */
export function createProvider(): LLMProvider {
  const baseUrl = process.env.NVIDIA_BASE_URL;
  const apiKey = process.env.NVIDIA_API_KEY;

  if (!baseUrl || !apiKey) {
    throw new Error("NVIDIA_BASE_URL and NVIDIA_API_KEY must be set");
  }

  return new NvidiaProvider(baseUrl, apiKey);
}

/**
 * Scan MODEL_MAP primary/fallback providers. Returns the set of providers
 * that are actually reachable through the router's virtual-role resolution.
 * NVIDIA is always included because embed + rerank use it directly
 * (see `ModelRouter.scheduleRaw` / `.raw`).
 */
export function collectRequiredProviders(
  map: typeof MODEL_MAP = MODEL_MAP,
): Set<ProviderName> {
  const required = new Set<ProviderName>(["nvidia"]);
  for (const route of Object.values(map)) {
    if (route.primaryProvider) required.add(route.primaryProvider);
    if (route.fallbackProvider) required.add(route.fallbackProvider);
  }
  return required;
}

/**
 * Stub provider for unreferenced slots. Preserves the full
 * `Record<ProviderName, LLMProvider>` shape so internal callers don't need
 * null-checks, while failing loudly if anything ever tries to route to an
 * unloaded provider (shouldn't happen — model-map never names it).
 */
function makeAbsentProvider(name: ProviderName): LLMProvider {
  const msg = `provider ${name} not loaded — model-map does not reference it`;
  const fail = (): never => {
    throw new Error(msg);
  };
  return {
    // Async methods reject rather than throw synchronously so callers using
    // `.catch` / `await` see a standard rejected promise.
    chat: async (_p: ChatParams): Promise<ChatResponse> => fail(),
    embed: async (): Promise<EmbedResponse> => fail(),
    rerank: async (): Promise<RerankResponse> => fail(),
    listModels: async (): Promise<ModelInfo[]> => fail(),
    // chatStream is sync in the LLMProvider contract — throw immediately.
    chatStream: (_p: ChatParams): ReadableStream<Uint8Array> => fail(),
  };
}

/**
 * Create providers required by the current MODEL_MAP.
 *
 * - NVIDIA: always required (embed + rerank + fallback).
 * - MiniMax / Copilot / OpenRouter: loaded only when MODEL_MAP references
 *   them as primary or fallback. Missing env key for a referenced provider
 *   is fail-fast; unreferenced providers are replaced with a stub that
 *   throws on any call.
 */
export async function createProviders(): Promise<
  Record<ProviderName, LLMProvider>
> {
  const required = collectRequiredProviders();

  // NVIDIA — always mandatory
  const nvidiaUrl = process.env.NVIDIA_BASE_URL;
  const nvidiaKey = process.env.NVIDIA_API_KEY;
  if (!nvidiaUrl || !nvidiaKey) {
    throw new Error("NVIDIA_BASE_URL and NVIDIA_API_KEY must be set");
  }
  const nvidia: LLMProvider = new NvidiaProvider(nvidiaUrl, nvidiaKey);

  // OpenRouter — optional
  let openrouter: LLMProvider;
  if (required.has("openrouter")) {
    const orUrl =
      process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
    const orKey = process.env.OPENROUTER_API_KEY;
    if (!orKey) {
      throw new Error(
        "OPENROUTER_API_KEY must be set (referenced by MODEL_MAP)",
      );
    }
    openrouter = new NvidiaProvider(orUrl, orKey, {
      "HTTP-Referer": "https://subbrain.local",
      "X-Title": "Subbrain",
    });
  } else {
    openrouter = makeAbsentProvider("openrouter");
  }

  // Copilot — optional
  let copilot: LLMProvider;
  if (required.has("copilot")) {
    // Prefer GITHUB_COPILOT_TOKEN (ghu_ OAuth), fallback to GITHUB_TOKEN (ghp_ PAT → device flow)
    const copilotToken =
      process.env.GITHUB_COPILOT_TOKEN || process.env.GITHUB_TOKEN;
    if (!copilotToken) {
      throw new Error(
        "GITHUB_COPILOT_TOKEN or GITHUB_TOKEN must be set (Copilot referenced by MODEL_MAP)",
      );
    }
    const copilotImpl = new CopilotProvider(copilotToken, 16384);
    await copilotImpl.init();
    copilot = copilotImpl;
  } else {
    copilot = makeAbsentProvider("copilot");
  }

  // MiniMax — optional. If referenced but key missing, fail fast rather than
  // silently falling back to NVIDIA NIM (which was the old behaviour and hid
  // misconfiguration). When unreferenced, stub out.
  let minimax: LLMProvider;
  if (required.has("minimax")) {
    const minimaxUrl =
      process.env.MINIMAX_BASE_URL || "https://api.minimax.io/v1";
    const minimaxKey = process.env.MINIMAX_API_KEY;
    if (!minimaxKey) {
      // NOTE: pre-23b behaviour silently redirected to NVIDIA NIM when the
      // key was absent. Keep that fallback for dev ergonomics (MiniMax routes
      // currently fall back to NVIDIA anyway) but log loudly.
      console.warn(
        "[providers] MINIMAX_API_KEY not set; using NVIDIA NIM as MiniMax backend",
      );
      minimax = new NvidiaProvider(nvidiaUrl, nvidiaKey);
    } else {
      minimax = new MiniMaxProvider(minimaxUrl, minimaxKey);
    }
  } else {
    minimax = makeAbsentProvider("minimax");
  }

  // OpenAI-compat (CLIProxyAPI bridge) — optional. See
  // docs/completed/03-model-router.md "OpenAI-compat provider".
  let openaiCompat: LLMProvider;
  if (required.has("openai-compat")) {
    const url =
      process.env.OPENAI_COMPAT_BASE_URL || "http://cliproxy:8080/v1";
    const key = process.env.OPENAI_COMPAT_API_KEY || "cliproxy-local";
    openaiCompat = new OpenAICompatProvider(url, key);
  } else {
    openaiCompat = makeAbsentProvider("openai-compat");
  }

  return {
    nvidia,
    openrouter,
    copilot,
    minimax,
    "openai-compat": openaiCompat,
  };
}
