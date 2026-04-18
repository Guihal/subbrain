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

export class NvidiaProvider implements LLMProvider {
  private baseUrl: string;
  private apiKey: string;
  private extraHeaders: Record<string, string>;

  constructor(
    baseUrl: string,
    apiKey: string,
    extraHeaders: Record<string, string> = {},
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.extraHeaders = extraHeaders;
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      ...this.extraHeaders,
    };
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ ...params, stream: false }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new ProviderError(res.status, body);
    }

    return (await res.json()) as ChatResponse;
  }

  chatStream(params: ChatParams): ReadableStream<Uint8Array> {
    const url = `${this.baseUrl}/chat/completions`;
    const headers = this.headers();
    const body = JSON.stringify({ ...params, stream: true });

    return new ReadableStream({
      async start(controller) {
        const res = await fetch(url, {
          method: "POST",
          headers,
          body,
        });

        if (!res.ok) {
          const text = await res.text();
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({ error: { message: text, status: res.status } })}\n\n`,
            ),
          );
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          controller.close();
          return;
        }

        const reader = res.body?.getReader();
        if (!reader) {
          controller.close();
          return;
        }

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
        } catch (err) {
          controller.error(err);
        } finally {
          controller.close();
        }
      },
    });
  }

  async embed(params: EmbedParams): Promise<EmbedResponse> {
    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(params),
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
