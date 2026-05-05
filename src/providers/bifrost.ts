import { HttpError } from "../lib/errors";
import { fetchJson } from "../lib/http-client";
import { ProviderError } from "./nvidia";
import type {
  ChatParams,
  ChatResponse,
  EmbedParams,
  EmbedResponse,
  LLMProvider,
  ModelInfo,
  RerankParams,
  RerankResponse,
} from "./types";

export class BifrostProvider implements LLMProvider {
  constructor(
    private baseUrl: string,
    private apiKey: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    if (params.signal?.aborted) {
      throw params.signal.reason ?? new DOMException("Aborted", "AbortError");
    }
    try {
      return await fetchJson<ChatResponse>(
        `${this.baseUrl}/v1/chat/completions`,
        {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({ ...params, stream: false }),
        },
        { timeoutMs: 240_000, signal: params.signal },
      );
    } catch (e) {
      if (e instanceof HttpError) throw new ProviderError(e.status, e.body);
      throw e;
    }
  }

  chatStream(_p: ChatParams): ReadableStream<Uint8Array> {
    throw new Error("BifrostProvider.chatStream — implemented in P1-3");
  }

  embed(_p: EmbedParams): Promise<EmbedResponse> {
    throw new Error(
      "bifrost does not proxy embed/rerank — use ModelRouter.scheduleRaw / .raw for NVIDIA NIM directly",
    );
  }

  rerank(_p: RerankParams): Promise<RerankResponse> {
    throw new Error(
      "bifrost does not proxy embed/rerank — use ModelRouter.scheduleRaw / .raw for NVIDIA NIM directly",
    );
  }

  async listModels(): Promise<ModelInfo[]> {
    return [];
  }
}
