/**
 * AuthService unit tests (PR 25a — first routes → services slice).
 *
 * Pure unit coverage: no Elysia, no HTTP. Asserts `validateBearer`'s truth
 * table + timing-safety smoke. The HTTP integration of the service (middleware
 * bypasses, 401 shape) is covered by `tests/auth.test.ts` and
 * `tests/auth-coverage.test.ts`; do not duplicate those here.
 */

import { describe, expect, test } from "bun:test";
import { AuthService } from "../src/services/auth.service";

describe("AuthService.validateBearer", () => {
  const svc = new AuthService("abc");

  test("valid Bearer token → true", () => {
    expect(svc.validateBearer("Bearer abc")).toBe(true);
  });

  test("case-insensitive Bearer prefix", () => {
    expect(svc.validateBearer("bearer abc")).toBe(true);
    expect(svc.validateBearer("BEARER abc")).toBe(true);
  });

  test("wrong token same length → false", () => {
    expect(svc.validateBearer("Bearer abd")).toBe(false);
  });

  test("wrong token different length → false (no throw)", () => {
    expect(() => svc.validateBearer("Bearer abcd")).not.toThrow();
    expect(svc.validateBearer("Bearer abcd")).toBe(false);
    expect(svc.validateBearer("Bearer a")).toBe(false);
  });

  test("null header → false", () => {
    expect(svc.validateBearer(null)).toBe(false);
  });

  test("empty string header → false", () => {
    expect(svc.validateBearer("")).toBe(false);
  });

  test("non-Bearer scheme → false", () => {
    expect(svc.validateBearer("Basic abc")).toBe(false);
    expect(svc.validateBearer("Token abc")).toBe(false);
    expect(svc.validateBearer("abc")).toBe(false); // no scheme at all
  });

  test("Bearer with empty token → false", () => {
    expect(svc.validateBearer("Bearer ")).toBe(false);
    expect(svc.validateBearer("Bearer")).toBe(false);
  });
});

describe("AuthService.getToken", () => {
  test("returns constructor token", () => {
    const svc = new AuthService("super-secret");
    expect(svc.getToken()).toBe("super-secret");
  });
});

describe("AuthService timing-safety smoke", () => {
  /**
   * Rough timing check: compare many valid-token calls vs many wrong-but-
   * same-length calls. Since both sides hash the input to a 32-byte digest
   * and `timingSafeEqual` is constant-time, the totals should be within a
   * small multiplicative factor. We use a generous 10× bound — this is a
   * smoke test, not a cryptographic proof, so CI jitter (GC, other cores)
   * doesn't false-positive.
   */
  test("valid vs wrong token timing within 10×", () => {
    const token = "a".repeat(64);
    const wrong = "b".repeat(64);
    const svc = new AuthService(token);
    const ITER = 1000;

    // Warm-up so JIT / hash caches settle before we measure.
    for (let i = 0; i < 200; i++) {
      svc.validateBearer(`Bearer ${token}`);
      svc.validateBearer(`Bearer ${wrong}`);
    }

    const t0 = Bun.nanoseconds();
    for (let i = 0; i < ITER; i++) svc.validateBearer(`Bearer ${token}`);
    const tValid = Bun.nanoseconds() - t0;

    const t1 = Bun.nanoseconds();
    for (let i = 0; i < ITER; i++) svc.validateBearer(`Bearer ${wrong}`);
    const tWrong = Bun.nanoseconds() - t1;

    const ratio = Math.max(tValid, tWrong) / Math.max(1, Math.min(tValid, tWrong));
    expect(ratio).toBeLessThan(10);
  });
});
