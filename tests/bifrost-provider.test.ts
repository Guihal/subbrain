import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BifrostProvider } from "../src/providers/bifrost";
import { ProviderError } from "../src/providers/nvidia";

describe("BifrostProvider", () => {
  const apiKey = "sk-bifrost-test-key-very-long-12345";
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl = "";
  type Hit = { url: string; method: string; headers: Headers; body: string };
  const hits: Hit[] = [];
  let nextStatus = 200;
  let nextBody: string | null = null;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const body = req.method === "POST" ? await req.text() : "";
        hits.push({ url: url.pathname, method: req.method, headers: req.headers, body });
        if (nextStatus !== 200) return new Response(nextBody ?? "boom", { status: nextStatus });
        if (url.pathname === "/v1/chat/completions") {
          if (body.includes('"stream":true')) {
            const sse =
              'data: {"id":"x","object":"chat.completion.chunk","created":0,"model":"gpt-4","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\ndata: [DONE]\n\n';
            return new Response(sse, {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            });
          }
          return Response.json({
            id: "r1",
            object: "chat.completion",
            created: 0,
            model: "gpt-4",
            choices: [
              { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
            ],
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    baseUrl = `http://localhost:${server.port}`;
  });

  afterAll(() => server.stop(true));

  function reset() {
    hits.length = 0;
    nextStatus = 200;
    nextBody = null;
  }

  test("chat sends correct payload and headers", async () => {
    reset();
    const p = new BifrostProvider(baseUrl, apiKey);
    await p.chat({ model: "gpt-4", messages: [{ role: "user", content: "hello" }] });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.url).toBe("/v1/chat/completions");
    expect(hits[0]?.method).toBe("POST");
    const headers = hits[0]?.headers as Headers;
    expect(headers.get("Authorization")).toBe(`Bearer ${apiKey}`);
    expect(headers.get("Content-Type")).toBe("application/json");

    const body = JSON.parse(hits[0]?.body ?? "{}");
    expect(body.model).toBe("gpt-4");
    expect(body.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(body.stream).toBe(false);
  });

  test("chat throws ProviderError on 4xx/5xx", async () => {
    reset();
    nextStatus = 429;
    nextBody = JSON.stringify({ error: "rate limited" });

    const p = new BifrostProvider(baseUrl, apiKey);
    await expect(p.chat({ model: "x", messages: [] })).rejects.toBeInstanceOf(ProviderError);
  });

  test("ProviderError redacts API key in body", async () => {
    reset();
    nextStatus = 401;
    nextBody = JSON.stringify({ error: "bad key", key: apiKey });

    const p = new BifrostProvider(baseUrl, apiKey);
    try {
      await p.chat({ model: "x", messages: [] });
      expect(false).toBe(true); // should throw
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError);
      const pe = e as ProviderError;
      expect(pe.body).not.toContain(apiKey);
      expect(pe.body).toContain("[REDACTED]");
    }
  });

  test("pre-flight abort throws DOMException without fetch", async () => {
    reset();
    const ctrl = new AbortController();
    ctrl.abort(new DOMException("Aborted", "AbortError"));

    const p = new BifrostProvider(baseUrl, apiKey);
    await expect(p.chat({ model: "x", messages: [], signal: ctrl.signal })).rejects.toBeInstanceOf(
      DOMException,
    );
    expect(hits).toHaveLength(0);
  });

  test("embed and rerank throw with clear message", () => {
    const p = new BifrostProvider(baseUrl, apiKey);
    expect(() => p.embed({ model: "x", input: "hi" })).toThrow(
      /bifrost does not proxy embed\/rerank/,
    );
    expect(() => p.rerank({ model: "x", query: "q", documents: [] })).toThrow(
      /bifrost does not proxy embed\/rerank/,
    );
  });

  test("listModels returns empty array", async () => {
    const p = new BifrostProvider(baseUrl, apiKey);
    expect(await p.listModels()).toEqual([]);
  });
});
