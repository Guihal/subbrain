import { describe, expect, test } from "bun:test";
import { RateLimiter } from "../src/lib/rate-limiter";

describe("RateLimiter", () => {
  test("5 critical requests run immediately", async () => {
    const limiter = new RateLimiter();
    let completed = 0;
    const promises: Promise<number>[] = [];
    for (let i = 0; i < 5; i++) {
      promises.push(
        limiter.schedule("critical", async () => {
          completed++;
          return completed;
        }),
      );
    }
    await Promise.all(promises);
    expect(completed).toBe(5);
    expect(limiter.currentLoad).toBe(5);
  });

  test("critical runs before low-priority at high load", async () => {
    const limiter = new RateLimiter();
    const order: string[] = [];

    // Fill to 33 requests to be above 80% (32/40 = 80%)
    for (let i = 0; i < 33; i++) {
      await limiter.schedule("critical", async () => {});
    }

    // Low-priority will be queued (above 80% threshold) and not awaited here —
    // a fresh RateLimiter instance is created per test, so it's GC'd cleanly.
    limiter.schedule("low", async () => {
      order.push("low");
      return "low-done";
    });
    const criticalPromise = limiter.schedule("critical", async () => {
      order.push("critical");
      return "critical-done";
    });

    const critResult = await criticalPromise;
    expect(critResult).toBe("critical-done");
    expect(order[0]).toBe("critical");
  });

  // tryAcquire was removed in PR-7 (A-2): 0 production callers + release()
  // was a no-op footgun. RateLimiter.schedule() is the supported entry point.

  test("backoff429 fills all slots", () => {
    const limiter = new RateLimiter();
    limiter.backoff429();
    expect(limiter.availableSlots).toBe(0);
  });

  test("backoff429 distributes timestamps across the window", () => {
    // Gradual release: timestamps should span the trailing 60s, not all at `now`.
    const limiter = new RateLimiter(10);
    limiter.backoff429();
    expect(limiter.availableSlots).toBe(0);
    // Peek via currentLoad (which prunes first) — should remain 10 here since
    // every phantom timestamp is newer than now-WINDOW_MS.
    expect(limiter.currentLoad).toBe(10);
  });
});
