import { describe, test, expect } from "bun:test";
import { paginate } from "../src/lib/api-envelope";

describe("paginate", () => {
  test("default page=1 page_size=20", async () => {
    const res = await paginate(
      () => ({ items: [1, 2, 3], total: 100 }),
      {},
    );
    expect(res).toEqual({ items: [1, 2, 3], total: 100, page: 1, page_size: 20 });
  });

  test("clamps page_size to 200", async () => {
    let capturedLimit = -1;
    await paginate(
      (limit) => {
        capturedLimit = limit;
        return { items: [], total: 0 };
      },
      { page_size: 9999 },
    );
    expect(capturedLimit).toBe(200);
  });

  test("computes offset from page", async () => {
    let capturedOffset = -1;
    await paginate(
      (_, offset) => {
        capturedOffset = offset;
        return { items: [], total: 0 };
      },
      { page: 3, page_size: 10 },
    );
    expect(capturedOffset).toBe(20);
  });

  test("q passthrough", async () => {
    let captured: string | undefined = "none";
    await paginate(
      (_l, _o, q) => {
        captured = q;
        return { items: [], total: 0 };
      },
      { q: "hello" },
    );
    expect(captured).toBe("hello");
  });

  test("empty q becomes undefined", async () => {
    let captured: string | undefined = "x";
    await paginate(
      (_l, _o, q) => {
        captured = q;
        return { items: [], total: 0 };
      },
      { q: "   " },
    );
    expect(captured).toBeUndefined();
  });

  test("legacy limit/offset still works", async () => {
    let capturedLimit = -1;
    let capturedOffset = -1;
    const res = await paginate(
      (l, o) => {
        capturedLimit = l;
        capturedOffset = o;
        return { items: [], total: 0 };
      },
      { limit: 25, offset: 50 },
    );
    expect(capturedLimit).toBe(25);
    expect(capturedOffset).toBe(50);
    expect(res.page_size).toBe(25);
    expect(res.page).toBe(3); // 50/25 + 1
  });

  test("page clamped to ≥1", async () => {
    const res = await paginate(() => ({ items: [], total: 0 }), { page: 0 });
    expect(res.page).toBe(1);
  });
});
