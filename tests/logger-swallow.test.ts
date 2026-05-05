/**
 * OBS-1: logger no longer silently drops Layer 4 writes on CHECK violation.
 *
 * Before the fix, `logger.ts`'s `catch {}` swallowed every SQLite CHECK
 * violation raised by `appendLog`, which meant 100% of logger traffic
 * vanished on any schema drift. The fix: still swallow (must not break
 * app flow), but `console.error` once per unique rejected role so the
 * drift is visible in stderr.
 *
 * Strategy: inject a fake MemoryDB whose `appendLog` throws a CHECK error,
 * call `logger.info` repeatedly, and assert console.error fires exactly once
 * for the first distinct role — never twice for the same role, once more for
 * a second distinct role.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { MemoryDB } from "@subbrain/core/db";
import { _warnedRejectedRoles, Logger } from "@subbrain/core/lib/logger";

function makeThrowingMemory(err: Error): MemoryDB {
  const stub = {
    appendLog: () => {
      throw err;
    },
  };
  // Cast is safe: logger only touches `appendLog` on the injected memory.
  return stub as unknown as MemoryDB;
}

describe("logger — silent swallow fix (OBS-1)", () => {
  let consoleLogSpy: ReturnType<typeof spyOn>;
  let consoleErrSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
    consoleErrSpy = spyOn(console, "error").mockImplementation(() => {});
    // The Set is module-level and process-lifetime. Clear so each test starts
    // from a clean slate without caring about test order.
    _warnedRejectedRoles.clear();
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrSpy.mockRestore();
    _warnedRejectedRoles.clear();
  });

  test("CHECK violation warns exactly once per unique role", () => {
    const log = new Logger("debug");
    log.setMemory(makeThrowingMemory(new Error("CHECK constraint failed: role IN (...)")));

    log.info("stage", "m1");
    log.info("stage", "m2");
    log.info("stage", "m3");

    // level=info → role=_log_info. Three calls, same role, one warning.
    expect(consoleErrSpy).toHaveBeenCalledTimes(1);
    const firstArg = consoleErrSpy.mock.calls[0][0] as string;
    expect(firstArg).toContain("_log_info");
    expect(firstArg).toContain("CHECK");
  });

  test("different levels → different roles → warn once each", () => {
    const log = new Logger("debug");
    log.setMemory(makeThrowingMemory(new Error("CHECK constraint failed: role IN (...)")));

    log.info("stage", "m");
    log.warn("stage", "m");
    log.error("stage", "m");
    // Repeats of each should not re-warn.
    log.info("stage", "m");
    log.warn("stage", "m");
    log.error("stage", "m");

    expect(consoleErrSpy).toHaveBeenCalledTimes(3);
    const warnedRoles = consoleErrSpy.mock.calls.map((c) => c[0] as string);
    expect(warnedRoles.some((s) => s.includes("_log_info"))).toBe(true);
    expect(warnedRoles.some((s) => s.includes("_log_warn"))).toBe(true);
    expect(warnedRoles.some((s) => s.includes("_log_error"))).toBe(true);
  });

  test("non-CHECK errors still swallowed silently — never logged to console.error", () => {
    const log = new Logger("debug");
    log.setMemory(makeThrowingMemory(new Error("database is locked")));

    log.info("stage", "m1");
    log.warn("stage", "m2");

    expect(consoleErrSpy).not.toHaveBeenCalled();
  });

  test("logger never throws even when memory.appendLog throws", () => {
    const log = new Logger("debug");
    log.setMemory(makeThrowingMemory(new Error("CHECK constraint failed: role IN (...)")));

    expect(() => log.info("stage", "x")).not.toThrow();
    expect(() => log.error("stage", "y")).not.toThrow();
  });

  test("debug entries skip DB write → no CHECK path, no warning even if memory would throw", () => {
    const log = new Logger("debug");
    log.setMemory(makeThrowingMemory(new Error("CHECK constraint failed: role IN (...)")));

    log.debug("stage", "diag");
    // Debug entries are console-only; appendLog is skipped entirely.
    expect(consoleErrSpy).not.toHaveBeenCalled();
  });
});
