/**
 * Unified HTTP client. Replaces copy-paste `fetch` boilerplate across
 * providers / rag / telegram with a single entry point handling:
 *   - AbortSignal composition (caller signal + timeout)
 *   - x-request-id propagation
 *   - retry loop with linear backoff
 *   - typed errors: HttpError (4xx/5xx, parse fail) + HttpAbortError (timeout/user)
 */

import { HttpAbortError, HttpError } from "./errors";

export interface FetchJsonOpts {
  /** Overall timeout per attempt. Default 180_000ms. */
  timeoutMs?: number;
  /** Upstream signal — composed with per-attempt timeout. */
  signal?: AbortSignal;
  retry?: {
    attempts: number;
    /** Predicate on response status. If omitted, retries any !ok. */
    on?: (status: number) => boolean;
    /** Linear backoff: wait `backoffMs * attempt` before retry. */
    backoffMs?: number;
  };
  /** Propagated as `x-request-id` header; auto-generated if absent. */
  requestId?: string;
}

function composeSignal(timeoutMs: number, external?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!external) return timeout;
  const anyFn = (
    AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }
  ).any;
  if (typeof anyFn === "function") return anyFn([timeout, external]);
  // Fallback for runtimes without AbortSignal.any
  const ctrl = new AbortController();
  external.addEventListener("abort", () => ctrl.abort(external.reason), {
    once: true,
  });
  timeout.addEventListener("abort", () => ctrl.abort(timeout.reason), {
    once: true,
  });
  return ctrl.signal;
}

async function doFetch(
  url: string,
  init: RequestInit,
  opts: FetchJsonOpts,
): Promise<Response> {
  if (opts.signal?.aborted) throw new HttpAbortError("user", url);
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const reqId = opts.requestId ?? crypto.randomUUID();
  const headers = new Headers(init.headers);
  if (!headers.has("x-request-id")) headers.set("x-request-id", reqId);
  const signal = composeSignal(timeoutMs, opts.signal);
  try {
    return await fetch(url, { ...init, headers, signal });
  } catch (e) {
    const err = e as { name?: string };
    if (err?.name === "AbortError" || err?.name === "TimeoutError") {
      const reason: "timeout" | "user" = opts.signal?.aborted
        ? "user"
        : "timeout";
      throw new HttpAbortError(reason, url);
    }
    throw e;
  }
}

/**
 * Fetch returning the raw Response — use when body needs to be streamed.
 * Applies retry + error mapping; does NOT consume the body.
 */
export async function fetchStream(
  url: string,
  init: RequestInit = {},
  opts: FetchJsonOpts = {},
): Promise<Response> {
  const retry = opts.retry;
  let attempt = 0;
  while (true) {
    const res = await doFetch(url, init, opts);
    if (res.ok) return res;
    const shouldRetry =
      retry &&
      attempt < retry.attempts &&
      (retry.on ? retry.on(res.status) : true);
    if (shouldRetry) {
      attempt++;
      // Drain body so the connection can be reused.
      try {
        await res.text();
      } catch {}
      if (retry.backoffMs) {
        await Bun.sleep(retry.backoffMs * attempt);
      }
      continue;
    }
    const body = await res.text();
    throw new HttpError(res.status, body, {
      url,
      requestId: opts.requestId,
    });
  }
}

/**
 * Fetch + JSON.parse. Throws HttpError on non-2xx or unparseable body,
 * HttpAbortError on timeout/user abort.
 */
export async function fetchJson<T = unknown>(
  url: string,
  init: RequestInit = {},
  opts: FetchJsonOpts = {},
): Promise<T> {
  const res = await fetchStream(url, init, opts);
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(res.status, text, {
      url,
      parseError: true,
      requestId: opts.requestId,
    });
  }
}
