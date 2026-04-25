/**
 * OpenAI-compatible provider for the local CLIProxyAPI bridge container.
 * CLIProxyAPI exposes /v1/chat/completions in OpenAI shape and forwards to
 * chatgpt.com using a ChatGPT Pro OAuth token (Codex CLI auth.json).
 *
 * Wire format is identical to NvidiaProvider — only the `X-Subbrain-Provider`
 * header is added so cliproxy logs can attribute traffic.
 */
import { NvidiaProvider } from "./nvidia";

export class OpenAICompatProvider extends NvidiaProvider {
  constructor(
    baseUrl: string,
    apiKey: string,
    extraHeaders: Record<string, string> = {},
  ) {
    super(baseUrl, apiKey, {
      ...extraHeaders,
      "X-Subbrain-Provider": "openai-compat",
    });
  }
}
