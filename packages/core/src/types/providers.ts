/**
 * OpenAI-compatible chat message.
 *
 * `content` is `string | null` after route-level normalization; multipart
 * arrays from clients are flattened to a single string at the API boundary.
 * `reasoning_content` is non-standard but emitted by some upstreams (Copilot
 * via Claude/Gemini) and surfaced through the pipeline.
 */
export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface Tool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ChatParams {
  model: string;
  messages: Message[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stream?: boolean;
  tools?: Tool[];
  tool_choice?: string | { type: string; function: { name: string } };
  /**
   * Abort signal propagated down to `fetch()` + SSE readers. Providers must
   * check `signal?.aborted` at the start of chat/chatStream and rethrow
   * `DOMException("Aborted", "AbortError")` from in-flight reads.
   */
  signal?: AbortSignal;
}

export interface ChatResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: {
    index: number;
    message: Message;
    finish_reason: string | null;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ChatChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: {
    index: number;
    delta: Partial<Message>;
    finish_reason: string | null;
  }[];
}

export interface EmbedParams {
  model: string;
  input: string | string[];
  encoding_format?: "float" | "base64";
  input_type?: "query" | "passage";
  /**
   * H-1: optional cancel signal threaded into the underlying `fetchJson` so a
   * caller-side abort (SSE disconnect, tool timeout, request abort) actually
   * stops the embed call instead of letting it run to completion and burning
   * NVIDIA RPM on a discarded result.
   */
  signal?: AbortSignal;
}

export interface EmbedResponse {
  object: "list";
  data: { object: "embedding"; index: number; embedding: number[] }[];
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
}

export interface RerankParams {
  model: string;
  query: string;
  passages: { text: string }[];
  top_n?: number;
}

export interface RerankResponse {
  results: { index: number; relevance_score: number }[];
}

export interface ModelInfo {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}

export interface LLMProvider {
  chat(params: ChatParams): Promise<ChatResponse>;
  chatStream(params: ChatParams): ReadableStream<Uint8Array>;
  embed(params: EmbedParams): Promise<EmbedResponse>;
  rerank(params: RerankParams): Promise<RerankResponse>;
  listModels(): Promise<ModelInfo[]>;
}
