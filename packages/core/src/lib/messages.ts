import type { Message } from "@subbrain/core/types/providers";

/**
 * Flatten an OpenAI-style content field to a plain string.
 * - string → string
 * - null / undefined → null
 * - array of multipart parts → join text fields with newlines
 *
 * Used at API ingress to coerce arbitrary client payloads to the strict
 * `Message.content: string | null` shape providers expect.
 */
export function normalizeContent(content: string | null | undefined | unknown[]): string | null {
  if (content == null) return null;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          const text = (part as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return null;
}

interface RawMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null | unknown[];
  name?: string;
  tool_calls?: Message["tool_calls"];
  tool_call_id?: string;
}

/**
 * Coerce an array of loosely-typed inbound messages to strict `Message[]`.
 * Drops nothing; only normalizes `content`.
 */
export function normalizeMessages(messages: RawMessage[]): Message[] {
  return messages.map((m) => ({
    role: m.role,
    content: normalizeContent(m.content),
    ...(m.name === undefined ? {} : { name: m.name }),
    ...(m.tool_calls === undefined ? {} : { tool_calls: m.tool_calls }),
    ...(m.tool_call_id === undefined ? {} : { tool_call_id: m.tool_call_id }),
  }));
}
