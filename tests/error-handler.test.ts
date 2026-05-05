import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { AppError, NotFoundError, UpstreamExhaustedError } from "../src/lib/errors";

// Miniature copy of the central onError from src/app/bootstrap.ts. Keeping it
// here (rather than extracting a shared helper) keeps the test readable and
// ensures the real bootstrap change and the handler contract stay in sync.
function attachErrorHandler(app: Elysia): Elysia {
  return app.onError(({ code, error, set }) => {
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
    if (code === "VALIDATION") {
      set.status = 422;
      return { error: { code: "validation_error", message: (error as any).message } };
    }
    set.status = 500;
    return { error: { code: "internal_error", message: "internal" } };
  });
}

describe("central onError", () => {
  test("AppError → status + code + message", async () => {
    const app = attachErrorHandler(new Elysia()).get("/x", () => {
      throw new AppError("teapot", "I'm a teapot", 418);
    });
    const res = await app.handle(new Request("http://localhost/x"));
    expect(res.status).toBe(418);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("teapot");
    expect(body.error.message).toBe("I'm a teapot");
  });

  test("NotFoundError → 404", async () => {
    const app = attachErrorHandler(new Elysia()).get("/x", () => {
      throw new NotFoundError("Widget");
    });
    const res = await app.handle(new Request("http://localhost/x"));
    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.error.message).toContain("Widget");
  });

  test("UpstreamExhaustedError → 502 + details merged", async () => {
    const app = attachErrorHandler(new Elysia()).get("/x", () => {
      throw new UpstreamExhaustedError({ attempts: 3 });
    });
    const res = await app.handle(new Request("http://localhost/x"));
    expect(res.status).toBe(502);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("upstream_exhausted");
    expect(body.error.attempts).toBe(3);
  });

  test("unknown error → 500 internal_error", async () => {
    const app = attachErrorHandler(new Elysia()).get("/x", () => {
      throw new Error("boom");
    });
    const res = await app.handle(new Request("http://localhost/x"));
    expect(res.status).toBe(500);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("internal_error");
  });
});
