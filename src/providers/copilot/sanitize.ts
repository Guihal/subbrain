import type { Message, ChatParams } from "../types";

/**
 * Sanitize messages for Copilot API compatibility.
 * - Normalizes content: arrays → joined string, null → "" for assistant+tool_calls
 * - Strips unknown fields that Copilot API might reject
 */
export function sanitizeMessages(messages: Message[]): Message[] {
  return messages.map((msg) => {
    let content: string | null;
    const raw = msg.content as unknown;
    if (Array.isArray(raw)) {
      content = raw
        .map((p) => {
          if (typeof p === "string") return p;
          if (p && typeof p === "object" && "text" in p) {
            const t = (p as { text?: unknown }).text;
            return typeof t === "string" ? t : "";
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
    } else if (raw == null) {
      content = msg.tool_calls ? "" : null;
    } else if (typeof raw === "string") {
      content = raw;
    } else {
      content = String(raw);
    }

    const clean: Message = { role: msg.role, content };
    if (msg.tool_calls) clean.tool_calls = msg.tool_calls;
    if (msg.tool_call_id) clean.tool_call_id = msg.tool_call_id;
    if (msg.name) clean.name = msg.name;
    return clean;
  });
}

export function clampMaxTokens(params: ChatParams, maxOutputTokens?: number): ChatParams {
  if (
    maxOutputTokens &&
    params.max_tokens &&
    params.max_tokens > maxOutputTokens
  ) {
    return { ...params, max_tokens: maxOutputTokens };
  }
  return params;
}
