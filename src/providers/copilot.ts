/**
 * GitHub Copilot API provider.
 *
 * Auth flow:
 * 1. Use GitHub PAT to request a short-lived Copilot session token
 *    POST https://api.github.com/copilot_internal/v2/token
 * 2. Use the session token for API calls to https://api.githubcopilot.com
 * 3. Auto-refresh token before expiry (tokens live ~30 min)
 *
 * Copilot Pro models: gpt-4o, gpt-4o-mini, claude-sonnet-4, gemini-2.0-flash-001
 * Endpoint is OpenAI-compatible: /chat/completions with SSE streaming.
 */
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
import { ProviderError } from "./nvidia";

const TOKEN_ENDPOINT = "https://api.github.com/copilot_internal/v2/token";
const API_BASE = "https://api.githubcopilot.com";
const TOKEN_REFRESH_MARGIN = 5 * 60; // Refresh 5 min before expiry

interface CopilotToken {
  token: string;
  expires_at: number; // Unix timestamp
}

export class CopilotProvider implements LLMProvider {
  private githubPat: string;
  private cachedToken: CopilotToken | null = null;
  private refreshPromise: Promise<CopilotToken> | null = null;

  constructor(githubPat: string) {
    this.githubPat = githubPat;
  }

  /** Get a valid Copilot session token, refreshing if needed */
  private async getToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);

    if (this.cachedToken && this.cachedToken.expires_at - now > TOKEN_REFRESH_MARGIN) {
      return this.cachedToken.token;
    }

    // Deduplicate concurrent refresh requests
    if (!this.refreshPromise) {
      this.refreshPromise = this.fetchToken().finally(() => {
        this.refreshPromise = null;
      });
    }

    this.cachedToken = await this.refreshPromise;
    return this.cachedToken.token;
  }

  private async fetchToken(): Promise<CopilotToken> {
    const res = await fetch(TOKEN_ENDPOINT, {
      method: "GET",
      headers: {
        Authorization: `token ${this.githubPat}`,
        Accept: "application/json",
        "User-Agent": "subbrain/1.0",
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new ProviderError(
        res.status,
        `Copilot token refresh failed: ${body}`,
      );
    }

    const data = (await res.json()) as CopilotToken;
    return data;
  }

  private async headers(): Promise<Record<string, string>> {
    const token = await this.getToken();
    return {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Copilot-Integration-Id": "vscode-chat",
      "Editor-Version": "vscode/1.100.0",
      "Editor-Plugin-Version": "copilot/1.0.0",
      "User-Agent": "subbrain/1.0",
    };
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    const headers = await this.headers();
    const res = await fetch(`${API_BASE}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...params, stream: false }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new ProviderError(res.status, body);
    }

    return (await res.json()) as ChatResponse;
  }

  chatStream(params: ChatParams): ReadableStream<Uint8Array> {
    const getHeaders = () => this.headers();

    return new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        try {
          const headers = await getHeaders();
          const res = await fetch(`${API_BASE}/chat/completions`, {
            method: "POST",
            headers,
            body: JSON.stringify({ ...params, stream: true }),
            signal: AbortSignal.timeout(180_000),
          });

          if (!res.ok) {
            const text = await res.text();
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ error: { message: text, status: res.status } })}\n\n`,
              ),
            );
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
            return;
          }

          const reader = res.body?.getReader();
          if (!reader) {
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
            return;
          }

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
          controller.close();
        } catch (err) {
          const encoder2 = new TextEncoder();
          const msg = err instanceof Error ? err.message : String(err);
          try {
            controller.enqueue(
              encoder2.encode(
                `data: ${JSON.stringify({ error: { message: msg, type: "stream_error" } })}\n\n`,
              ),
            );
            controller.enqueue(encoder2.encode("data: [DONE]\n\n"));
            controller.close();
          } catch {
            // Controller already closed
          }
        }
      },
    });
  }

  async embed(_params: EmbedParams): Promise<EmbedResponse> {
    throw new ProviderError(
      501,
      "Copilot API does not support embeddings. Use NVIDIA provider.",
    );
  }

  async rerank(_params: RerankParams): Promise<RerankResponse> {
    throw new ProviderError(
      501,
      "Copilot API does not support rerank. Use NVIDIA provider.",
    );
  }

  async listModels(): Promise<ModelInfo[]> {
    // Copilot doesn't expose a models list endpoint — return known models
    const now = Math.floor(Date.now() / 1000);
    return [
      { id: "gpt-4o", object: "model", created: now, owned_by: "copilot" },
      { id: "gpt-4o-mini", object: "model", created: now, owned_by: "copilot" },
      { id: "claude-sonnet-4", object: "model", created: now, owned_by: "copilot" },
      { id: "gemini-2.0-flash-001", object: "model", created: now, owned_by: "copilot" },
    ];
  }
}
