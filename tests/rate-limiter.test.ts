import { describe, test, expect } from "bun:test";
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

  test("backoff429 fills all slots", () => {
    const limiter = new RateLimiter();
    limiter.backoff429();
    expect(limiter.availableSlots).toBe(0);
  });
});
