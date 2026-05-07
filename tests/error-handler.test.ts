/**
 * Tests for the central HTTP error handler.
 *
 * Imports the real `handleAppError` from `packages/server/src/app/error-handler.ts`
 * — the same function `createApp(deps)` mounts via Elysia `.onError`. No
 * mini-copy, no Elysia bootstrap dance: invoke it directly with a synthetic
 * `set` capture and assert the contract callers actually depend on.
 */
import { describe, expect, test } from "bun:test";
import { AppError, NotFoundError, UpstreamExhaustedError } from "@subbrain/core/lib/errors";
import {
  type AppErrorContext,
  handleAppError,
} from "../packages/server/src/app/error-handler";

function invoke(error: unknown, code = "UNKNOWN", path = "/x") {
  const set = { status: 0 };
  const ctx: AppErrorContext = { code, error, set, path };
  const body = handleAppError(ctx) as { error: Record<string, unknown> };
  return { status: set.status, body };
}

describe("handleAppError — central onError", () => {
  test("AppError → status + code + message", () => {
    const { status, body } = invoke(new AppError("teapot", "I'm a teapot", 418));
    expect(status).toBe(418);
    expect(body.error.code).toBe("teapot");
    expect(body.error.message).toBe("I'm a teapot");
  });

  test("NotFoundError → 404 with not_found code", () => {
    const { status, body } = invoke(new NotFoundError("Widget"));
    expect(status).toBe(404);
    expect(body.error.code).toBe("not_found");
    expect(body.error.message).toContain("Widget");
  });

  test("UpstreamExhaustedError → 502 + details merged into envelope", () => {
    const { status, body } = invoke(new UpstreamExhaustedError({ attempts: 3 }));
    expect(status).toBe(502);
    expect(body.error.code).toBe("upstream_exhausted");
    expect(body.error.attempts).toBe(3);
  });

  test("AppError details merge into top-level error envelope", () => {
    const err = new AppError("bad_thing", "nope", 400, { hint: "retry", attempt: 2 });
    const { status, body } = invoke(err);
    expect(status).toBe(400);
    expect(body.error.hint).toBe("retry");
    expect(body.error.attempt).toBe(2);
  });

  test("VALIDATION code → 422 with validation_error envelope", () => {
    const err = { message: "Expected string for property 'name'", type: "validation_error" };
    const { status, body } = invoke(err, "VALIDATION", "/v1/chat/completions");
    expect(status).toBe(422);
    expect(body.error.code).toBe(422);
    expect(body.error.type).toBe("validation_error");
    expect(body.error.message).toContain("Validation error:");
    expect(body.error.message).toContain("Expected string");
  });

  test("VALIDATION with empty error message → fallback prefix", () => {
    const { status, body } = invoke({}, "VALIDATION", "/x");
    expect(status).toBe(422);
    expect(body.error.message).toContain("invalid request body");
  });

  test("VALIDATION truncates long messages to 300 chars", () => {
    const long = "x".repeat(500);
    const { body } = invoke({ message: long }, "VALIDATION", "/x");
    const msg = body.error.message as string;
    // "Validation error: " (18) + 300 chars truncated body = 318 max
    expect(msg.length).toBeLessThanOrEqual(318);
  });

  test("unknown native Error → 500 internal_error", () => {
    const { status, body } = invoke(new Error("boom"), "UNKNOWN", "/x");
    expect(status).toBe(500);
    expect(body.error.code).toBe("internal_error");
    expect(body.error.message).toBe("internal");
  });

  test("non-Error throw (string) → 500 internal_error (no crash)", () => {
    const { status, body } = invoke("kaboom" as unknown, "UNKNOWN", "/x");
    expect(status).toBe(500);
    expect(body.error.code).toBe("internal_error");
  });

  test("null/undefined error → 500 internal_error (no crash)", () => {
    const { status, body } = invoke(null, "UNKNOWN", "/x");
    expect(status).toBe(500);
    expect(body.error.code).toBe("internal_error");
  });
});
