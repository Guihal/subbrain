/**
 * Shared mock router + response builder for ArbitrationRoom test files.
 * Keeps each test file under the 150-line cap by extracting boilerplate.
 */

import type { ChatResponse, Message } from "@subbrain/core/types/providers";

export interface Call {
  model: string;
  messages: Message[];
}

export function makeResponse(content: string): ChatResponse {
  return {
    id: "test-id",
    object: "chat.completion",
    created: Date.now(),
    model: "mock",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

/**
 * Mock router with deterministic per-role replies. Push every call to
 * `calls` (mutated in place) so tests can assert dispatch fan-out.
 */
export function happyRouter(calls: Call[]): never {
  return {
    chat: async (model: string, params: { messages: Message[] }) => {
      calls.push({ model, messages: params.messages });
      if (model === "teamlead") return makeResponse("Synthesized answer from team.");
      if (model === "coder") return makeResponse("Coder says: use a HashMap.");
      if (model === "critic") return makeResponse("Critic says: watch for race conditions.");
      if (model === "generalist") return makeResponse("Generalist says: consider trade-offs.");
      return makeResponse("Unknown role response.");
    },
  } as never;
}
