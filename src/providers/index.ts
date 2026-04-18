import type { LLMProvider } from "./types";
import { NvidiaProvider } from "./nvidia";
import type { ProviderName } from "../lib/model-map";

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

/** Create all configured providers */
export function createProviders(): Record<ProviderName, LLMProvider> {
  const nvidiaUrl = process.env.NVIDIA_BASE_URL;
  const nvidiaKey = process.env.NVIDIA_API_KEY;
  if (!nvidiaUrl || !nvidiaKey) {
    throw new Error("NVIDIA_BASE_URL and NVIDIA_API_KEY must be set");
  }

  const orUrl =
    process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
  const orKey = process.env.OPENROUTER_API_KEY;
  if (!orKey) {
    throw new Error("OPENROUTER_API_KEY must be set");
  }

  return {
    nvidia: new NvidiaProvider(nvidiaUrl, nvidiaKey),
    openrouter: new NvidiaProvider(orUrl, orKey, {
      "HTTP-Referer": "https://subbrain.local",
      "X-Title": "Subbrain",
    }),
  };
}
