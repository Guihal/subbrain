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

/** HTTP-level failure from an upstream fetch: 4xx/5xx or unparseable body. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly meta: { url: string; requestId?: string; parseError?: boolean },
  ) {
    super(`HTTP ${status} @ ${meta.url}: ${body.slice(0, 200)}`);
    this.name = "HttpError";
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
