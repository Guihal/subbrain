import { describe, expect, test } from "bun:test";
import { RateLimiter } from "@subbrain/agent/scheduler/agent-pool/pool/rate-limits";

describe("agent-pool rate-limits", () => {
  test("allow returns true for unseen type", () => {
    const rl = new RateLimiter();
    expect(rl.allow("free")).toBe(true);
    expect(rl.allow("clear")).toBe(true);
  });

  test("allow returns false immediately after recordCompletion", () => {
    const rl = new RateLimiter();
    rl.recordCompletion("free", 1_000_000);
    expect(rl.allow("free", 1_000_000)).toBe(false);
    expect(rl.allow("free", 1_000_000 + 59_999)).toBe(false);
  });

  test("allow returns true after cooldown expires", () => {
    const rl = new RateLimiter();
    rl.recordCompletion("free", 1_000_000);
    expect(rl.allow("free", 1_000_000 + 60_000)).toBe(true);
  });

  test("scheduled has 5min cooldown", () => {
    const rl = new RateLimiter();
    rl.recordCompletion("scheduled", 0);
    expect(rl.allow("scheduled", 299_999)).toBe(false);
    expect(rl.allow("scheduled", 300_000)).toBe(true);
  });

  test("unknown type uses default 60s cooldown", () => {
    const rl = new RateLimiter();
    rl.recordCompletion("research", 0);
    expect(rl.allow("research", 59_999)).toBe(false);
    expect(rl.allow("research", 60_000)).toBe(true);
  });

  test("types are independent", () => {
    const rl = new RateLimiter();
    rl.recordCompletion("free", 0);
    expect(rl.allow("clear", 0)).toBe(true);
  });
});
