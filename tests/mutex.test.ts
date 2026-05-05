import { describe, expect, test } from "bun:test";
import { Mutex } from "../packages/core/src/lib/mutex";

describe("Mutex", () => {
  test("sequential acquire/release works", async () => {
    const m = new Mutex();
    const release = await m.acquire();
    expect(typeof release).toBe("function");
    release();
    expect(m.tryAcquire()).not.toBeNull();
  });

  test("concurrent acquires resolve in FIFO order", async () => {
    const m = new Mutex();
    const order: number[] = [];
    const r1 = await m.acquire();
    const p2 = m.acquire().then((r) => {
      order.push(2);
      r();
    });
    const p3 = m.acquire().then((r) => {
      order.push(3);
      r();
    });
    const p4 = m.acquire().then((r) => {
      order.push(4);
      r();
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual([]);
    r1();
    await Promise.all([p2, p3, p4]);
    expect(order).toEqual([2, 3, 4]);
  });

  test("tryAcquire returns release fn when free, null when held", () => {
    const m = new Mutex();
    const r1 = m.tryAcquire();
    expect(typeof r1).toBe("function");
    expect(m.tryAcquire()).toBeNull();
    r1?.();
    const r2 = m.tryAcquire();
    expect(typeof r2).toBe("function");
    r2?.();
  });

  test("reentrant tryAcquire returns null", () => {
    const m = new Mutex();
    const r = m.tryAcquire();
    if (!r) throw new Error("expected release");
    expect(m.tryAcquire()).toBeNull();
    r();
  });

  test("reentrant acquire queues", async () => {
    const m = new Mutex();
    const r1 = await m.acquire();
    let resolved = false;
    m.acquire().then(() => {
      resolved = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBe(false);
    r1();
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toBe(true);
  });
});
