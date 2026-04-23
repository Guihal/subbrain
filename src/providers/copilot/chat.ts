import type { ChatParams, ChatResponse } from "../types";
import { fetchJson } from "../../lib/http-client";
import { HttpError } from "../../lib/errors";
import { ProviderError } from "../nvidia";
import { logger } from "../../lib/logger";
import { buildApiHeaders, COPILOT_API_URL } from "./headers";
import { sanitizeMessages, clampMaxTokens } from "./sanitize";
import type { CopilotAuth } from "./auth";

const log = logger.child("copilot");

export async function runChat(
  auth: CopilotAuth,
  params: ChatParams,
  maxOutputTokens: number | undefined,
): Promise<ChatResponse> {
  if (params.signal?.aborted) {
    throw params.signal.reason ?? new DOMException("Aborted", "AbortError");
  }
  const clamped = clampMaxTokens(params, maxOutputTokens);
  const sanitized = {
    ...clamped,
    messages: sanitizeMessages(clamped.messages),
  };
  const body = JSON.stringify({ ...sanitized, stream: false });
  const url = `${COPILOT_API_URL}/chat/completions`;

  const doRequest = async (): Promise<ChatResponse> => {
    const token = await auth.getToken();
    return await fetchJson<ChatResponse>(
      url,
      { method: "POST", headers: buildApiHeaders(token), body },
      { timeoutMs: 180_000, signal: params.signal },
    );
  };

  try {
    return await doRequest();
  } catch (e) {
    if (e instanceof HttpError) {
      log.warn(`chat() error ${e.status}: ${e.body.slice(0, 300)}`, {
        meta: {
          roles: sanitized.messages.map((m) => m.role),
          hasToolCalls: sanitized.messages.some((m) => m.tool_calls),
          hasToolResults: sanitized.messages.some((m) => m.role === "tool"),
        },
      });
      if (e.status === 401) {
        auth.invalidateToken();
        try {
          return await doRequest();
        } catch (e2) {
          if (e2 instanceof HttpError) throw new ProviderError(e2.status, e2.body);
          throw e2;
        }
      }
      throw new ProviderError(e.status, e.body);
    }
    throw e;
  }
}
