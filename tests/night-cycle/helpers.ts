/** Shared test helpers for night-cycle test files. */
import type { ChatResponse } from "@subbrain/core/types/providers";

export const mkResponse = (content: string): ChatResponse => ({
  id: "test-id",
  object: "chat.completion",
  created: Date.now(),
  model: "mock",
  choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});
