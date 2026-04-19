import type {
  LLMProvider,
  ChatParams,
  ChatResponse,
  EmbedParams,
  EmbedResponse,
  RerankParams,
  RerankResponse,
  ModelInfo,
} from "./types";
import { createProxyStream } from "./stream-utils";

export class NvidiaProvider implements LLMProvider {
  private baseUrl: string;
  private apiKey: string;
  private extraHeaders: Record<string, string>;
  private maxOutputTokens?: number;

  constructor(
    baseUrl: string,
    apiKey: string,
    extraHeaders: Record<string, string> = {},
    maxOutputTokens?: number,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.extraHeaders = extraHeaders;
    this.maxOutputTokens = maxOutputTokens;
  }

  /** Clamp max_tokens if provider has a cap */
  private clamp(params: ChatParams): ChatParams {
    if (
      this.maxOutputTokens &&
      params.max_tokens &&
      params.max_tokens > this.maxOutputTokens
    ) {
      return { ...params, max_tokens: this.maxOutputTokens };
    }
    return params;
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      ...this.extraHeaders,
    };
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    const clamped = this.clamp(params);
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ ...clamped, stream: false }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new ProviderError(res.status, body);
    }

    return (await res.json()) as ChatResponse;
  }

  chatStream(params: ChatParams): ReadableStream<Uint8Array> {
    const clamped = this.clamp(params);
    const url = `${this.baseUrl}/chat/completions`;
    const headers = this.headers();
    const body = JSON.stringify({ ...clamped, stream: true });

    return createProxyStream(() =>
      fetch(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(180_000),
      }),
    );
  }

  async embed(params: EmbedParams): Promise<EmbedResponse> {
    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(30_000), // 30s — cold start can be slow
    });

    if (!res.ok) {
      const body = await res.text();
      throw new ProviderError(res.status, body);
    }

    return res.json() as Promise<EmbedResponse>;
  }

  async rerank(params: RerankParams): Promise<RerankResponse> {
    const res = await fetch(`${this.baseUrl}/ranking`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model: params.model,
        query: { text: params.query },
        passages: params.passages,
        top_n: params.top_n,
      }),
      signal: AbortSignal.timeout(30_000), // 30s — cold start can be slow
    });

    if (!res.ok) {
      const body = await res.text();
      throw new ProviderError(res.status, body);
    }

    return res.json() as Promise<RerankResponse>;
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await fetch(`${this.baseUrl}/models`, {
      headers: this.headers(),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new ProviderError(res.status, body);
    }

    const data = (await res.json()) as { data: ModelInfo[] };
    return data.data;
  }
}

export class ProviderError extends Error {
  status: number;
  body: string;

  constructor(status: number, body: string) {
    super(`Provider error ${status}: ${body}`);
    this.status = status;
    this.body = body;
  }
}
