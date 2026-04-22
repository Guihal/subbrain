/**
 * MiniMax adapter — OpenAI-compatible API that embeds reasoning inline as
 * `<think>...</think>` inside `content`. This adapter normalizes both
 * streaming and non-streaming responses so downstream code sees reasoning
 * only in `reasoning_content`, and re-wraps assistant history on the way out
 * (MiniMax requires preserved think tags across turns).
 *
 * Composition over inheritance: delegates HTTP to `NvidiaProvider` so the
 * shared `fetchJson` / `fetchStream` + AbortSignal + ProviderError flow
 * stays in one place.
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
  Message,
} from "./types";
import { NvidiaProvider } from "./nvidia";
import {
  transformThinkTags,
  splitThinkTagsOnce,
} from "./think-tag-transform";

export class MiniMaxProvider implements LLMProvider {
  private inner: NvidiaProvider;

  constructor(
    baseUrl: string,
    apiKey: string,
    extraHeaders: Record<string, string> = {},
    maxOutputTokens?: number,
  ) {
    this.inner = new NvidiaProvider(
      baseUrl,
      apiKey,
      extraHeaders,
      maxOutputTokens,
    );
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    const rewrapped: ChatParams = {
      ...params,
      messages: rewrapHistoryForMinimax(params.messages),
    };
    const resp = await this.inner.chat(rewrapped);
    return splitResponseThinkTags(resp);
  }

  chatStream(params: ChatParams): ReadableStream<Uint8Array> {
    const rewrapped: ChatParams = {
      ...params,
      messages: rewrapHistoryForMinimax(params.messages),
    };
    return transformThinkTags(this.inner.chatStream(rewrapped));
  }

  embed(params: EmbedParams): Promise<EmbedResponse> {
    return this.inner.embed(params);
  }

  rerank(params: RerankParams): Promise<RerankResponse> {
    return this.inner.rerank(params);
  }

  listModels(): Promise<ModelInfo[]> {
    return this.inner.listModels();
  }
}

/**
 * Restore original `<think>...</think>` wrapping on assistant history turns
 * before sending to MiniMax. Strips `reasoning_content` (MiniMax does not
 * recognize it — pass-through from OpenAI-generic fields is harmless for
 * most upstreams, but we keep outbound messages minimal).
 */
export function rewrapHistoryForMinimax(messages: Message[]): Message[] {
  return messages.map((m) => {
    if (m.role !== "assistant") return m;
    if (!m.reasoning_content) {
      if ("reasoning_content" in m) {
        const { reasoning_content: _rc, ...rest } = m;
        return rest as Message;
      }
      return m;
    }
    const { reasoning_content, ...rest } = m;
    return {
      ...rest,
      content: `<think>${reasoning_content}</think>\n${m.content ?? ""}`,
    };
  });
}

/**
 * Split `<think>` tags out of every choice's message content into
 * `reasoning_content`. Idempotent — if there are no tags, returns the
 * response unchanged (cheap early-out per choice).
 */
export function splitResponseThinkTags(resp: ChatResponse): ChatResponse {
  let touched = false;
  const choices = resp.choices.map((c) => {
    const { visible, thinking } = splitThinkTagsOnce(c.message.content);
    if (!thinking) return c;
    touched = true;
    return {
      ...c,
      message: {
        ...c.message,
        content: visible,
        reasoning_content:
          (c.message.reasoning_content ?? "") + thinking,
      },
    };
  });
  return touched ? { ...resp, choices } : resp;
}
