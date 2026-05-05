export interface ChatCompletionRequest {
  model: string;
  messages: unknown[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stream?: boolean;
  tools?: unknown;
  tool_choice?: unknown;
  [extra: string]: unknown;
}

export interface ChatMeta {
  chatId?: string;
  source: string;
  sessionId?: string;
  directModeForced: boolean;
  /**
   * B-1: optional `x-agent-id` header. Trust model: every authenticated caller
   * (single shared bearer token) is admin-grade, so this header is an
   * admin-controlled scoping primitive — it does not grant new access, it
   * narrows what the agent-loop sees from the shared context store. Validated
   * to a strict charset/length so a hostile token-holder cannot inject
   * arbitrary strings into `layer2_context.agent_id`.
   */
  agentId: string | null;
}

/**
 * B-1: validated identifier for `layer2_context.agent_id` and friends.
 * Lowercase-normalize after match — prevents two parallel buckets ("Alice"
 * vs "alice") that would silently break read/write symmetry under the
 * `(c.agent_id = ? OR c.agent_id IS NULL)` filter.
 */
const AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export function sanitizeAgentId(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const v = raw.trim();
  if (!v) return null;
  if (!AGENT_ID_RE.test(v)) return null;
  return v.toLowerCase();
}

export function extractChatMeta(h: Record<string, string | undefined>): ChatMeta {
  return {
    chatId: h["x-chat-id"],
    source: h["x-chat-source"] || "api",
    sessionId: h["x-session-id"],
    directModeForced: h["x-direct-mode"] === "true",
    agentId: sanitizeAgentId(h["x-agent-id"]),
  };
}
