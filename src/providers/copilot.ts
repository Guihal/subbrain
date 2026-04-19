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
import { createProxyStream } from "./stream-utils";
import { logger } from "../lib/logger";

const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
const COPILOT_API_URL = "https://api.githubcopilot.com";
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000; // refresh 5 min before expiry
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const DEVICE_TOKEN_URL = "https://github.com/login/oauth/access_token";
const COPILOT_CLIENT_ID = "Iv1.b507a08c87ecfe98";

interface CopilotToken {
  token: string;
  expires_at: number; // unix seconds
}

/**
 * GitHub Copilot provider.
 *
 * Auth flow:
 * 1. If GITHUB_COPILOT_TOKEN (ghu_) is set → use it directly
 * 2. Else use GITHUB_TOKEN (ghp_ PAT) to get OAuth token via device flow (one-time)
 * 3. OAuth token → /copilot_internal/v2/token → short-lived session token
 * 4. Session token → api.githubcopilot.com/chat/completions
 *
 * On first run without GITHUB_COPILOT_TOKEN, logs a device code for user to authorize.
 */
export class CopilotProvider implements LLMProvider {
  private oauthToken: string; // ghu_ or ghp_ token
  private cachedToken: CopilotToken | null = null;
  private refreshPromise: Promise<CopilotToken> | null = null;
  private maxOutputTokens?: number;
  private tokenFilePath: string;

  constructor(
    oauthToken: string,
    maxOutputTokens?: number,
    tokenFilePath?: string,
  ) {
    this.oauthToken = oauthToken;
    this.maxOutputTokens = maxOutputTokens;
    this.tokenFilePath = tokenFilePath || "data/copilot-oauth.txt";
  }

  /**
   * Initialize the provider. If no OAuth token exists, starts device flow.
   * Must be called before first use.
   */
  async init(): Promise<void> {
    // If we already have a ghu_ token, we're good
    if (this.oauthToken.startsWith("ghu_")) {
      logger.info("[copilot] Using provided OAuth token (ghu_)");
      return;
    }

    // Try loading saved OAuth token from disk
    try {
      const saved = await Bun.file(this.tokenFilePath).text();
      const trimmed = saved.trim();
      if (trimmed.startsWith("ghu_")) {
        this.oauthToken = trimmed;
        logger.info("[copilot] Loaded OAuth token from " + this.tokenFilePath);
        return;
      }
    } catch {
      // No saved token, continue to device flow
    }

    // Run device flow using PAT as fallback auth
    await this.deviceFlow();
  }

  private async deviceFlow(): Promise<void> {
    logger.info("[copilot] Starting GitHub Device OAuth flow...");

    const codeRes = await fetch(DEVICE_CODE_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: `client_id=${COPILOT_CLIENT_ID}&scope=copilot`,
    });

    if (!codeRes.ok) {
      throw new ProviderError(
        codeRes.status,
        `Device code request failed: ${await codeRes.text()}`,
      );
    }

    const codeData = (await codeRes.json()) as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      expires_in: number;
      interval: number;
    };

    // Log the code for user to authorize
    logger.info("═══════════════════════════════════════════════════════");
    logger.info("[copilot] AUTHORIZE COPILOT:");
    logger.info(`[copilot]   1. Open: ${codeData.verification_uri}`);
    logger.info(`[copilot]   2. Enter code: ${codeData.user_code}`);
    logger.info("[copilot]   Waiting for authorization...");
    logger.info("═══════════════════════════════════════════════════════");

    // Poll for authorization
    const deadline = Date.now() + codeData.expires_in * 1000;
    const interval = (codeData.interval || 5) * 1000;

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, interval));

      const tokenRes = await fetch(DEVICE_TOKEN_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: `client_id=${COPILOT_CLIENT_ID}&device_code=${codeData.device_code}&grant_type=urn:ietf:params:oauth:grant-type:device_code`,
      });

      const tokenData = (await tokenRes.json()) as {
        access_token?: string;
        error?: string;
      };

      if (tokenData.access_token) {
        this.oauthToken = tokenData.access_token;

        // Save to disk for future restarts
        await Bun.write(this.tokenFilePath, this.oauthToken);
        logger.info(
          `[copilot] OAuth token obtained and saved to ${this.tokenFilePath}`,
        );
        return;
      }

      if (tokenData.error === "authorization_pending") {
        continue;
      }

      if (tokenData.error === "slow_down") {
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }

      throw new ProviderError(400, `Device flow failed: ${tokenData.error}`);
    }

    throw new ProviderError(
      408,
      "Device flow timed out — user did not authorize",
    );
  }

  /** Get a valid Copilot session token, refreshing if needed */
  private async getToken(): Promise<string> {
    const now = Date.now() / 1000;
    if (
      this.cachedToken &&
      this.cachedToken.expires_at - TOKEN_REFRESH_MARGIN_MS / 1000 > now
    ) {
      return this.cachedToken.token;
    }

    // Deduplicate concurrent refresh calls
    if (!this.refreshPromise) {
      this.refreshPromise = this.fetchToken().finally(() => {
        this.refreshPromise = null;
      });
    }

    this.cachedToken = await this.refreshPromise;
    return this.cachedToken.token;
  }

  private async fetchToken(): Promise<CopilotToken> {
    const res = await fetch(COPILOT_TOKEN_URL, {
      headers: {
        Authorization: `token ${this.oauthToken}`,
        Accept: "application/json",
        "User-Agent": "GithubCopilot/1.0",
        "Editor-Version": "vscode/1.100.0",
        "Editor-Plugin-Version": "copilot-chat/0.25.0",
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const body = await res.text();
      // If 401/404 — OAuth token might have expired, clear saved file
      if (res.status === 401 || res.status === 404) {
        logger.info(
          "[copilot] OAuth token invalid/expired, re-running device flow...",
        );
        try {
          await Bun.write(this.tokenFilePath, "");
        } catch {}
        await this.deviceFlow();
        // Retry with new token
        return this.fetchToken();
      }
      throw new ProviderError(
        res.status,
        `Copilot token fetch failed: ${body}`,
      );
    }

    const data = (await res.json()) as CopilotToken;
    logger.info(
      `[copilot] Session token refreshed, expires at ${new Date(data.expires_at * 1000).toISOString()}`,
    );
    return data;
  }

  private async headers(): Promise<Record<string, string>> {
    const token = await this.getToken();
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "Copilot-Integration-Id": "vscode-chat",
      "Editor-Version": "vscode/1.115.0",
      "Editor-Plugin-Version": "copilot-chat/0.43.0",
    };
  }

  /**
   * Sanitize messages for Copilot API compatibility.
   * - Normalizes content: arrays → joined string, null → "" for assistant+tool_calls
   * - Strips unknown fields that Copilot API might reject
   */
  private sanitizeMessages(
    messages: ChatParams["messages"],
  ): ChatParams["messages"] {
    return messages.map((msg) => {
      const clean: Record<string, unknown> = { role: msg.role };

      // Normalize content
      if (Array.isArray(msg.content)) {
        // OpenAI multipart content → flatten to string
        clean.content = (msg.content as any[])
          .map((p: any) => (typeof p === "string" ? p : p?.text || ""))
          .join("\n");
      } else if (msg.content === null || msg.content === undefined) {
        // Some APIs reject null content on assistant messages with tool_calls
        clean.content = msg.tool_calls ? "" : (msg.content ?? null);
      } else {
        clean.content = msg.content;
      }

      if (msg.tool_calls) clean.tool_calls = msg.tool_calls;
      if (msg.tool_call_id) clean.tool_call_id = msg.tool_call_id;

      return clean as ChatParams["messages"][0];
    });
  }

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

  async chat(params: ChatParams): Promise<ChatResponse> {
    const clamped = this.clamp(params);
    const sanitized = {
      ...clamped,
      messages: this.sanitizeMessages(clamped.messages),
    };
    const reqHeaders = await this.headers();
    const res = await fetch(`${COPILOT_API_URL}/chat/completions`, {
      method: "POST",
      headers: reqHeaders,
      body: JSON.stringify({ ...sanitized, stream: false }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const body = await res.text();
      logger.warn(
        "[copilot]",
        `chat() error ${res.status}: ${body.slice(0, 300)}`,
        {
          meta: {
            roles: sanitized.messages.map((m) => m.role),
            hasToolCalls: sanitized.messages.some((m) => m.tool_calls),
            hasToolResults: sanitized.messages.some((m) => m.role === "tool"),
          },
        } as any,
      );
      if (res.status === 401) {
        this.cachedToken = null;
        const retryHeaders = await this.headers();
        const retry = await fetch(`${COPILOT_API_URL}/chat/completions`, {
          method: "POST",
          headers: retryHeaders,
          body: JSON.stringify({ ...sanitized, stream: false }),
          signal: AbortSignal.timeout(60_000),
        });
        if (!retry.ok) {
          throw new ProviderError(retry.status, await retry.text());
        }
        return (await retry.json()) as ChatResponse;
      }
      throw new ProviderError(res.status, body);
    }

    return (await res.json()) as ChatResponse;
  }

  chatStream(params: ChatParams): ReadableStream<Uint8Array> {
    const clamped = this.clamp(params);
    const sanitized = {
      ...clamped,
      messages: this.sanitizeMessages(clamped.messages),
    };
    const self = this;

    const bodyPayload = { ...sanitized, stream: true };
    const bodyStr = JSON.stringify(bodyPayload);
    logger.info(
      "[copilot]",
      `chatStream() model=${sanitized.model} msgs=${sanitized.messages.length} tools=${sanitized.tools?.length ?? 0} bodySize=${bodyStr.length}`,
    );
    // Debug: log first few messages structure
    for (let i = 0; i < Math.min(5, sanitized.messages.length); i++) {
      const m = sanitized.messages[i];
      const info: Record<string, unknown> = {
        role: m.role,
        contentType: typeof m.content,
        contentLen:
          typeof m.content === "string" ? m.content.length : m.content,
      };
      if (m.tool_calls) info.tool_calls_count = m.tool_calls.length;
      if ((m as any).tool_call_id) info.tool_call_id = (m as any).tool_call_id;
      if ((m as any).name) info.name = (m as any).name;
      logger.info("[copilot]", `  msg[${i}]: ${JSON.stringify(info)}`);
    }

    return createProxyStream(async () => {
      const hdrs = await self.headers();
      return fetch(`${COPILOT_API_URL}/chat/completions`, {
        method: "POST",
        headers: hdrs,
        body: bodyStr,
        signal: AbortSignal.timeout(180_000),
      });
    });
  }

  async embed(_params: EmbedParams): Promise<EmbedResponse> {
    throw new ProviderError(
      501,
      "Copilot provider does not support embeddings — use NVIDIA",
    );
  }

  async rerank(_params: RerankParams): Promise<RerankResponse> {
    throw new ProviderError(
      501,
      "Copilot provider does not support rerank — use NVIDIA",
    );
  }

  async listModels(): Promise<ModelInfo[]> {
    return [
      {
        id: "claude-sonnet-4.6",
        object: "model",
        created: 0,
        owned_by: "anthropic",
      },
      {
        id: "gemini-3.1-pro-preview",
        object: "model",
        created: 0,
        owned_by: "google",
      },
      { id: "gpt-5.4-mini", object: "model", created: 0, owned_by: "openai" },
      { id: "gpt-4o", object: "model", created: 0, owned_by: "openai" },
      { id: "gpt-4o-mini", object: "model", created: 0, owned_by: "openai" },
      {
        id: "gemini-3-flash-preview",
        object: "model",
        created: 0,
        owned_by: "google",
      },
    ];
  }
}
