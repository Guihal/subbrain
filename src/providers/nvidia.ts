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
import { fetchJson, fetchStream } from "../lib/http-client";
import { HttpError } from "../lib/errors";

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
    if (params.signal?.aborted)
      throw params.signal.reason ?? new DOMException("Aborted", "AbortError");
    const clamped = this.clamp(params);
    try {
      return await fetchJson<ChatResponse>(
        `${this.baseUrl}/chat/completions`,
        {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({ ...clamped, stream: false }),
        },
        { timeoutMs: 180_000, signal: params.signal },
      );
    } catch (e) {
      if (e instanceof HttpError) throw new ProviderError(e.status, e.body);
      throw e;
    }
  }

  chatStream(params: ChatParams): ReadableStream<Uint8Array> {
    const clamped = this.clamp(params);
    const url = `${this.baseUrl}/chat/completions`;
    const headers = this.headers();
    const body = JSON.stringify({ ...clamped, stream: true });

    return createProxyStream(() => {
      if (params.signal?.aborted)
        throw params.signal.reason ?? new DOMException("Aborted", "AbortError");
      return fetchStream(
        url,
        { method: "POST", headers, body },
        { timeoutMs: 180_000, signal: params.signal },
      );
    });
  }

  async embed(params: EmbedParams): Promise<EmbedResponse> {
    try {
      return await fetchJson<EmbedResponse>(
        `${this.baseUrl}/embeddings`,
        {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify(params),
        },
        { timeoutMs: 30_000 },
      );
    } catch (e) {
      if (e instanceof HttpError) throw new ProviderError(e.status, e.body);
      throw e;
    }
  }

  async rerank(params: RerankParams): Promise<RerankResponse> {
    try {
      return await fetchJson<RerankResponse>(
        `${this.baseUrl}/ranking`,
        {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({
            model: params.model,
            query: { text: params.query },
            passages: params.passages,
            top_n: params.top_n,
          }),
        },
        { timeoutMs: 30_000 },
      );
    } catch (e) {
      if (e instanceof HttpError) throw new ProviderError(e.status, e.body);
      throw e;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const data = await fetchJson<{ data: ModelInfo[] }>(
        `${this.baseUrl}/models`,
        { headers: this.headers() },
      );
      return data.data;
    } catch (e) {
      if (e instanceof HttpError) throw new ProviderError(e.status, e.body);
      throw e;
    }
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
