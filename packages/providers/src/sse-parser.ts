import { logger } from "@subbrain/core/lib/logger";
import type { ToolCall } from "./types";

export interface ProviderDelta {
  content?: string;
  reasoning_content?: string;
  tool_calls?: Array<{
    index: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
  finish_reason?: "stop" | "tool_calls" | "length" | null;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

/** Parse one SSE line into a structured delta. Returns null for ping/empty/[DONE]/malformed. */
export function parseSSEChunk(line: string): ProviderDelta | null {
  if (!line.startsWith("data: ")) return null;
  const data = line.slice(6).trim();
  if (!data || data === "[DONE]") return null;
  try {
    const chunk = JSON.parse(data);
    const choice = chunk.choices?.[0];
    if (!choice) return null;
    const delta = choice.delta ?? {};
    const result: ProviderDelta = {};
    if (typeof delta.content === "string") result.content = delta.content;
    if (typeof delta.reasoning_content === "string")
      result.reasoning_content = delta.reasoning_content;
    if (delta.tool_calls) result.tool_calls = delta.tool_calls;
    if (choice.finish_reason != null) result.finish_reason = choice.finish_reason;
    if (chunk.usage) {
      result.usage = {
        prompt_tokens: chunk.usage.prompt_tokens,
        completion_tokens: chunk.usage.completion_tokens,
      };
    }
    return result;
  } catch {
    logger.warn("sse-parser", `Malformed SSE chunk: ${data.slice(0, 100)}`);
    return null;
  }
}

/** Merge accumulated deltas into a final assistant message. */
export function assembleMessage(deltas: ProviderDelta[]): {
  role: "assistant";
  content: string | null;
  reasoning_content?: string;
  tool_calls?: ToolCall[];
  finish_reason: string | null;
  usage?: { prompt_tokens: number; completion_tokens: number };
} {
  let content = "";
  let reasoning = "";
  let finish_reason: string | null = null;
  let usage: { prompt_tokens: number; completion_tokens: number } | undefined;
  const toolCallMap = new Map<number, ToolCall>();

  for (const delta of deltas) {
    if (delta.content) content += delta.content;
    if (delta.reasoning_content) reasoning += delta.reasoning_content;
    if (delta.finish_reason != null) finish_reason = delta.finish_reason;
    if (delta.usage) usage = delta.usage;
    for (const tc of delta.tool_calls ?? []) {
      if (!toolCallMap.has(tc.index)) {
        toolCallMap.set(tc.index, {
          id: tc.id ?? "",
          type: "function",
          function: { name: tc.function?.name ?? "", arguments: "" },
        });
      }
      const existing = toolCallMap.get(tc.index)!;
      if (tc.id) existing.id = tc.id;
      if (tc.function?.name) existing.function.name = tc.function.name;
      if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
    }
  }

  const tool_calls =
    toolCallMap.size > 0
      ? [...toolCallMap.entries()].sort(([a], [b]) => a - b).map(([, tc]) => tc)
      : undefined;

  return {
    role: "assistant",
    content: content || null,
    ...(reasoning ? { reasoning_content: reasoning } : {}),
    ...(tool_calls ? { tool_calls } : {}),
    finish_reason,
    ...(usage ? { usage } : {}),
  };
}
