/**
 * Unified application error types.
 *
 * Thrown anywhere in request handling; caught by the central `onError` in
 * `src/app/bootstrap.ts`. Keeps status + machine-readable code alongside the
 * message, plus an optional `details` bag that the handler serializes into
 * the JSON response body.
 */

export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 500,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class UpstreamExhaustedError extends AppError {
  constructor(details?: Record<string, unknown>) {
    super("upstream_exhausted", "All upstream attempts failed", 502, details);
    this.name = "UpstreamExhaustedError";
  }
}

export class ToolError extends AppError {
  constructor(toolName: string, code: string, message: string) {
    // status 200: tool errors are not HTTP failures — they flow back to the
    // model as normal tool results so it can react.
    super(code, message, 200, { tool: toolName });
    this.name = "ToolError";
  }
}

export class NotFoundError extends AppError {
  constructor(what: string) {
    super("not_found", `${what} not found`, 404);
    this.name = "NotFoundError";
  }
}

const SECRET_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._-]+/gi,
  /(?:api[_-]?key|authorization|token)\s*[:=]\s*["']?[A-Za-z0-9._-]+["']?/gi,
  /\bghu_[A-Za-z0-9]{20,}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bsk-(?:ant-)?[A-Za-z0-9._-]{20,}\b/g,
  /\bnvapi-[A-Za-z0-9._-]{10,}\b/g,
];

/**
 * Strip common API-key/token shapes from a string before logging or echoing
 * upstream bodies back to the client. Idempotent — running twice is safe.
 */
export function redactSecrets(input: string): string {
  if (!input) return input;
  let out = input;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED]");
  return out;
}

/** HTTP-level failure from an upstream fetch: 4xx/5xx or unparseable body. */
export class HttpError extends Error {
  readonly status: number;
  readonly body: string;
  readonly meta: { url: string; requestId?: string; parseError?: boolean };
  constructor(
    status: number,
    body: string,
    meta: { url: string; requestId?: string; parseError?: boolean },
  ) {
    const safe = redactSecrets(body);
    super(`HTTP ${status} @ ${meta.url}: ${safe.slice(0, 200)}`);
    this.name = "HttpError";
    this.status = status;
    this.body = safe;
    this.meta = meta;
  }
}

/** fetch aborted — either by caller signal ("user") or timeout. */
export class HttpAbortError extends Error {
  constructor(
    readonly reason: "timeout" | "user",
    readonly url: string,
  ) {
    super(`Aborted (${reason}): ${url}`);
    this.name = "HttpAbortError";
  }
}
