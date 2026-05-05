import { UpstreamExhaustedError } from "@subbrain/core/lib/errors";
import type { ModelTarget, Priority, ProviderName } from "@subbrain/core/lib/model-map";
import { ProviderError } from "../nvidia";
import type { ChatParams, ChatResponse } from "../types";
import { type Backend, MAX_FALLBACK_ATTEMPTS, REQUEST_TIMEOUT } from "./constants";
import { withTimeout } from "./timeout";

export interface DispatchDeps {
  getBackend: (provider: ProviderName) => Backend;
  handleProviderError: (err: ProviderError, provider: ProviderName) => void;
}

/**
 * Primary dispatch: call → 5xx retry-same-once → capped fallback → UpstreamExhaustedError.
 * 401/403 short-circuit without fallback.
 */
export async function runChatDispatch(
  backend: Backend,
  primary: ModelTarget,
  fallback: ModelTarget | null,
  params: Omit<ChatParams, "model">,
  priority: Priority,
  deps: DispatchDeps,
): Promise<ChatResponse> {
  const attempts: { model: string; status: number; body: string }[] = [];

  // Primary (+ 5xx retry-same-once)
  try {
    return await withTimeout(
      backend.provider.chat({ ...params, model: primary.model }),
      REQUEST_TIMEOUT,
      primary.model,
    );
  } catch (err) {
    if (!(err instanceof ProviderError)) throw err;
    deps.handleProviderError(err, primary.provider);
    attempts.push({
      model: primary.model,
      status: err.status,
      body: err.message,
    });
    // Auth failures short-circuit — no fallback, no wrap.
    if (err.status === 401 || err.status === 403) throw err;
    if (err.status >= 500) {
      try {
        return await withTimeout(
          backend.provider.chat({ ...params, model: primary.model }),
          REQUEST_TIMEOUT,
          `${primary.model} (retry)`,
        );
      } catch (retryErr) {
        if (retryErr instanceof ProviderError) {
          attempts.push({
            model: primary.model,
            status: retryErr.status,
            body: retryErr.message,
          });
        } else {
          throw retryErr;
        }
      }
    }
  }

  // Fallback (capped at MAX_FALLBACK_ATTEMPTS)
  let fallbackUsed = 0;
  if (fallback && fallbackUsed < MAX_FALLBACK_ATTEMPTS) {
    fallbackUsed++;
    try {
      return await callFallback(fallback, params, priority, deps);
    } catch (fbErr) {
      if (fbErr instanceof ProviderError) {
        attempts.push({
          model: fallback.model,
          status: fbErr.status,
          body: fbErr.message,
        });
      } else {
        throw fbErr;
      }
    }
  }

  const last = attempts[attempts.length - 1];
  throw new UpstreamExhaustedError({
    lastStatus: last?.status,
    lastBody: last?.body,
    attempts,
  });
}

async function callFallback(
  target: ModelTarget,
  params: Omit<ChatParams, "model">,
  priority: Priority,
  deps: DispatchDeps,
): Promise<ChatResponse> {
  const fb = deps.getBackend(target.provider);
  const call = () =>
    withTimeout(
      fb.provider.chat({ ...params, model: target.model }),
      REQUEST_TIMEOUT,
      target.model,
    );
  // Always use the fallback backend's limiter
  return fb.limiter.schedule(priority, call);
}
