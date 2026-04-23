import type { ChatParams } from "../types";
import { fetchStream } from "../../lib/http-client";
import { createProxyStream } from "../stream-utils";
import { logger } from "../../lib/logger";
import { buildApiHeaders, COPILOT_API_URL } from "./headers";
import { sanitizeMessages, clampMaxTokens } from "./sanitize";
import type { CopilotAuth } from "./auth";

const log = logger.child("copilot");

export function runChatStream(
  auth: CopilotAuth,
  params: ChatParams,
  maxOutputTokens: number | undefined,
): ReadableStream<Uint8Array> {
  const clamped = clampMaxTokens(params, maxOutputTokens);
  const sanitized = {
    ...clamped,
    messages: sanitizeMessages(clamped.messages),
  };
  const bodyPayload = { ...sanitized, stream: true };
  const bodyStr = JSON.stringify(bodyPayload);
  log.info(
    `chatStream() model=${sanitized.model} msgs=${sanitized.messages.length} tools=${sanitized.tools?.length ?? 0} bodySize=${bodyStr.length}`,
  );
  for (let i = 0; i < Math.min(5, sanitized.messages.length); i++) {
    const m = sanitized.messages[i];
    const info: Record<string, unknown> = {
      role: m.role,
      contentType: typeof m.content,
      contentLen: typeof m.content === "string" ? m.content.length : m.content,
    };
    if (m.tool_calls) info.tool_calls_count = m.tool_calls.length;
    if ((m as any).tool_call_id) info.tool_call_id = (m as any).tool_call_id;
    if ((m as any).name) info.name = (m as any).name;
    log.info(`  msg[${i}]: ${JSON.stringify(info)}`);
  }

  return createProxyStream(async () => {
    if (params.signal?.aborted) {
      throw params.signal.reason ?? new DOMException("Aborted", "AbortError");
    }
    const token = await auth.getToken();
    return fetchStream(
      `${COPILOT_API_URL}/chat/completions`,
      { method: "POST", headers: buildApiHeaders(token), body: bodyStr },
      { timeoutMs: 300_000, signal: params.signal },
    );
  });
}
