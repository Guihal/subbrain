import type { ModelInfo } from "../types";

export function listCopilotModels(): ModelInfo[] {
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
