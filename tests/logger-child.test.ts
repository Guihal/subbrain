import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Logger } from "../src/lib/logger";

describe("logger.child", () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  beforeEach(() => {
    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleSpy.mockRestore();
  });

  test("child prefixes stage", () => {
    const log = new Logger("debug");
    const scoped = log.child("minimax");
    scoped.info("started");
    expect(consoleSpy).toHaveBeenCalled();
    const line = consoleSpy.mock.calls[0][0] as string;
    expect(line).toContain("[minimax]");
    expect(line).toContain("started");
  });

  test("nested child chains with dots", () => {
    const log = new Logger("debug");
    log.child("minimax").child("stream").warn("slow");
    const line = consoleSpy.mock.calls[0][0] as string;
    expect(line).toContain("[minimax.stream]");
    expect(line).toContain("slow");
  });

  test("scoped logger exposes all levels", () => {
    const log = new Logger("debug");
    const scoped = log.child("x");
    scoped.debug("d");
    scoped.info("i");
    scoped.warn("w");
    scoped.error("e");
    expect(consoleSpy).toHaveBeenCalledTimes(4);
  });
});
