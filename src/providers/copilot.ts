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
import { CopilotAuth } from "./copilot/auth";
import { runChat } from "./copilot/chat";
import { runChatStream } from "./copilot/stream";
import { listCopilotModels } from "./copilot/models";

/**
 * GitHub Copilot provider.
 *
 * Auth flow:
 * 1. If GITHUB_COPILOT_TOKEN (ghu_) is set → use it directly
 * 2. Else use GITHUB_TOKEN (ghp_ PAT) to get OAuth token via device flow (one-time)
 * 3. OAuth token → /copilot_internal/v2/token → short-lived session token
 * 4. Session token → api.githubcopilot.com/chat/completions
 */
export class CopilotProvider implements LLMProvider {
  private auth: CopilotAuth;
  private maxOutputTokens?: number;

  constructor(oauthToken: string, maxOutputTokens?: number, tokenFilePath?: string) {
    this.auth = new CopilotAuth(oauthToken, tokenFilePath);
    this.maxOutputTokens = maxOutputTokens;
  }

  async init(): Promise<void> {
    return this.auth.init();
  }

  chat(params: ChatParams): Promise<ChatResponse> {
    return runChat(this.auth, params, this.maxOutputTokens);
  }

  chatStream(params: ChatParams): ReadableStream<Uint8Array> {
    return runChatStream(this.auth, params, this.maxOutputTokens);
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
    return listCopilotModels();
  }
}
