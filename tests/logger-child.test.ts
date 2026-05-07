import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { type LogEntry, Logger } from "@subbrain/core/lib/logger";

// Public contract under test: ScopedLogger (returned by `Logger.child`)
// must forward calls to the parent `Logger.log` with the `stage` field on
// the structured `LogEntry` set to the child's namespace, and nested
// `.child()` calls must dot-chain that namespace. We assert the structured
// shape — not the formatted console line — so format internals
// (timestamp / icon / brackets) can change without breaking this test.

describe("logger.child", () => {
  let logSpy: ReturnType<typeof spyOn>;
  let captured: LogEntry[];

  beforeEach(() => {
    captured = [];
    // Spy on the structured entry-point. Both the no-memory fallback and
    // any DB write go through `Logger.log(entry)`, so this is the single
    // stable seam regardless of sink.
    logSpy = spyOn(Logger.prototype, "log").mockImplementation(function (
      this: Logger,
      entry: LogEntry,
    ) {
      captured.push(entry);
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  test("child sets stage on structured entry", () => {
    const log = new Logger("debug");
    const scoped = log.child("minimax");
    scoped.info("started");

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      level: "info",
      stage: "minimax",
      message: "started",
    });
  });

  test("nested child chains stage with dots", () => {
    const log = new Logger("debug");
    log.child("minimax").child("stream").warn("slow");

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      level: "warn",
      stage: "minimax.stream",
      message: "slow",
    });
  });

  test("scoped logger forwards all four levels", () => {
    const log = new Logger("debug");
    const scoped = log.child("x");
    scoped.debug("d");
    scoped.info("i");
    scoped.warn("w");
    scoped.error("e");

    expect(captured).toHaveLength(4);
    expect(captured.map((e) => e.level)).toEqual(["debug", "info", "warn", "error"]);
    // Every emitted entry must carry the bound stage — that is the whole
    // point of `child()`. Asserting on the structured field rather than
    // a substring of the rendered line keeps us decoupled from format.
    expect(captured.every((e) => e.stage === "x")).toBe(true);
  });

  test("child preserves extra fields (model, durationMs, meta)", () => {
    const log = new Logger("debug");
    const scoped = log.child("provider");
    scoped.info("call done", { model: "glm-5.1", durationMs: 1234, meta: { ok: true } });

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      level: "info",
      stage: "provider",
      message: "call done",
      model: "glm-5.1",
      durationMs: 1234,
      meta: { ok: true },
    });
  });
});
