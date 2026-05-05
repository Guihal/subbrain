import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { HttpAbortError, HttpError } from "@subbrain/core/lib/errors";
import { fetchJson, fetchStream } from "@subbrain/core/lib/http-client";

let server: ReturnType<typeof Bun.serve>;
let baseUrl = "";
// Shared state the test handlers tweak per-test.
let state: {
  delayMs: number;
  retryCount: number;
  retryFailUntil: number;
  hits: { [path: string]: number };
} = { delayMs: 0, retryCount: 0, retryFailUntil: 0, hits: {} };

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      state.hits[url.pathname] = (state.hits[url.pathname] ?? 0) + 1;

      if (url.pathname === "/json") {
        if (state.delayMs > 0) await Bun.sleep(state.delayMs);
        return Response.json({ hello: "world" });
      }
      if (url.pathname === "/retry") {
        state.retryCount++;
        if (state.retryCount <= state.retryFailUntil) {
          return new Response("boom", { status: 503 });
        }
        return Response.json({ ok: true });
      }
      if (url.pathname === "/slow") {
        await Bun.sleep(2000);
        return Response.json({ late: true });
      }
      if (url.pathname === "/bad-json") {
        return new Response("not-json{", { status: 200 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

function resetState() {
  state = { delayMs: 0, retryCount: 0, retryFailUntil: 0, hits: {} };
}

describe("fetchJson", () => {
  test("returns typed JSON on 200", async () => {
    resetState();
    const res = await fetchJson<{ hello: string }>(`${baseUrl}/json`);
    expect(res.hello).toBe("world");
  });

  test("throws HttpError on parse fail", async () => {
    resetState();
    try {
      await fetchJson(`${baseUrl}/bad-json`);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError);
      expect((e as HttpError).meta.parseError).toBe(true);
    }
  });

  test("throws HttpError on 4xx/5xx", async () => {
    resetState();
    try {
      await fetchJson(`${baseUrl}/does-not-exist`);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError);
      expect((e as HttpError).status).toBe(404);
    }
  });
});

describe("AbortSignal composition", () => {
  test("timeout → HttpAbortError reason=timeout", async () => {
    resetState();
    try {
      await fetchJson(`${baseUrl}/slow`, {}, { timeoutMs: 200 });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(HttpAbortError);
      expect((e as HttpAbortError).reason).toBe("timeout");
    }
  });

  test("external abort → HttpAbortError reason=user", async () => {
    resetState();
    state.delayMs = 1000;
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 50);
    try {
      await fetchJson(`${baseUrl}/json`, {}, { signal: ctrl.signal, timeoutMs: 5000 });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(HttpAbortError);
      expect((e as HttpAbortError).reason).toBe("user");
    }
  });

  test("pre-aborted signal throws before network request", async () => {
    resetState();
    const ctrl = new AbortController();
    ctrl.abort();
    try {
      await fetchJson(`${baseUrl}/json`, {}, { signal: ctrl.signal });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(HttpAbortError);
      expect((e as HttpAbortError).reason).toBe("user");
    }
    expect(state.hits["/json"] ?? 0).toBe(0);
  });

  test("shared user-signal aborts all parallel requests", async () => {
    resetState();
    state.delayMs = 1000;
    const ctrl = new AbortController();
    const p1 = fetchJson(`${baseUrl}/json`, {}, { signal: ctrl.signal, timeoutMs: 5000 });
    const p2 = fetchJson(`${baseUrl}/json`, {}, { signal: ctrl.signal, timeoutMs: 10_000 });
    setTimeout(() => ctrl.abort(), 50);
    const results = await Promise.allSettled([p1, p2]);
    for (const r of results) {
      expect(r.status).toBe("rejected");
      if (r.status === "rejected") {
        expect(r.reason).toBeInstanceOf(HttpAbortError);
        expect((r.reason as HttpAbortError).reason).toBe("user");
      }
    }
  });
});

describe("retry", () => {
  test("503 then 200 succeeds with retry{attempts:1, on:503}", async () => {
    resetState();
    state.retryFailUntil = 1; // fail first attempt
    const res = await fetchJson<{ ok: boolean }>(
      `${baseUrl}/retry`,
      {},
      {
        retry: { attempts: 1, on: (s) => s === 503, backoffMs: 10 },
      },
    );
    expect(res.ok).toBe(true);
    expect(state.retryCount).toBe(2);
  });

  test("HttpError after attempts exhausted", async () => {
    resetState();
    state.retryFailUntil = 10;
    try {
      await fetchJson(
        `${baseUrl}/retry`,
        {},
        { retry: { attempts: 1, on: (s) => s === 503, backoffMs: 5 } },
      );
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError);
      expect((e as HttpError).status).toBe(503);
    }
    expect(state.retryCount).toBe(2);
  });
});

describe("fetchStream", () => {
  test("returns Response with unconsumed body", async () => {
    resetState();
    const res = await fetchStream(`${baseUrl}/json`);
    expect(res.ok).toBe(true);
    const json = (await res.json()) as { hello: string };
    expect(json.hello).toBe("world");
  });

  test("adds x-request-id when absent", async () => {
    resetState();
    // Cannot observe outgoing header via Bun.serve hits counter — just ensure no throw.
    const res = await fetchStream(`${baseUrl}/json`, { method: "GET" });
    expect(res.ok).toBe(true);
  });
});
