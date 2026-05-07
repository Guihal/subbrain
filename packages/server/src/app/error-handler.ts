/**
 * Central HTTP error handler — mounted via Elysia `.onError` in `bootstrap.ts`.
 *
 * Extracted so tests can exercise the real contract directly without
 * bootstrapping the full Elysia app (see `tests/error-handler.test.ts`).
 *
 * M-1: tolerate Elysia's heterogeneous error shapes at one boundary.
 */

import { AppError } from "@subbrain/core/lib/errors";
import { logger } from "@subbrain/core/lib/logger";

interface ErrorLike {
  message?: string;
  validator?: unknown;
  type?: string;
  stack?: string;
}

function toErrorLike(err: unknown): ErrorLike {
  if (!err || typeof err !== "object") return {};
  const e = err as Record<string, unknown>;
  return {
    message: typeof e.message === "string" ? e.message : undefined,
    validator: e.validator,
    type: typeof e.type === "string" ? e.type : undefined,
    stack: typeof e.stack === "string" ? e.stack : undefined,
  };
}

export interface AppErrorContext {
  code: string;
  error: unknown;
  set: { status: number };
  path: string;
}

export function handleAppError({ code, error, set, path }: AppErrorContext) {
  if (error instanceof AppError) {
    set.status = error.status;
    return {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ?? {}),
      },
    };
  }
  const e = toErrorLike(error);
  if (code === "VALIDATION") {
    logger.warn("validation", `422 on ${path}: ${e.message?.slice(0, 500) || String(error)}`, {
      meta: { validator: e.validator, type: e.type },
    });
    set.status = 422;
    return {
      error: {
        message: `Validation error: ${e.message?.slice(0, 300) || "invalid request body"}`,
        type: "validation_error",
        code: 422,
      },
    };
  }
  set.status = 500;
  logger.error("http", "unhandled", {
    meta: { path, err: e.message, stack: e.stack },
  });
  return {
    error: { code: "internal_error", message: "internal" },
  };
}
