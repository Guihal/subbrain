import { describe, expect, test } from "bun:test";
import { BifrostProvider } from "../src/providers/bifrost";
import { ProviderError } from "../src/providers/nvidia";

describe("BifrostProvider", () => {
  const baseUrl = "http://bifrost:8080";
  const apiKey = "sk-bifrost-test-key-very-long-12345";
  let fetchCalls: { url: string; init: RequestInit }[];
  let _originalFetch: typeof globalThis.fetch;

  function mockFetch(status: number, body: unknown) {
    return async (_url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(_url), init: init ?? {} });
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    };
  }

  function mockFetchError(status: number, bodyText: string) {
    return async (_url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(_url), init: init ?? {} });
      return new Response(bodyText, { status, headers: { "Content-Type": "application/json" } });
    };
  }

  test("chat sends correct payload and headers", async () => {
    fetchCalls = [];
    globalThis.fetch = mockFetch(200, {
      id: "1",
      object: "chat.completion",
      created: 1,
      model: "gpt-4",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    });

    const p = new BifrostProvider(baseUrl, apiKey);
    await p.chat({ model: "gpt-4", messages: [{ role: "user", content: "hello" }] });

    expect(fetchCalls).toHaveLength(1);
    const { url, init } = fetchCalls[0];
    expect(url).toEndWith("/v1/chat/completions");
    expect(init.method).toBe("POST");
    const headers = init.headers as Headers;
    expect(headers.get("Authorization")).toBe(`Bearer ${apiKey}`);
    expect(headers.get("Content-Type")).toBe("application/json");

    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("gpt-4");
    expect(body.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(body.stream).toBe(false);
  });

  test("chat throws ProviderError on 4xx/5xx", async () => {
    fetchCalls = [];
    globalThis.fetch = mockFetchError(429, JSON.stringify({ error: "rate limited" }));

    const p = new BifrostProvider(baseUrl, apiKey);
    await expect(p.chat({ model: "x", messages: [] })).rejects.toBeInstanceOf(ProviderError);
  });

  test("ProviderError redacts API key in body", async () => {
    fetchCalls = [];
    const errBody = JSON.stringify({ error: "bad key", key: apiKey });
    globalThis.fetch = mockFetchError(401, errBody);

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
    fetchCalls = [];
    globalThis.fetch = async () => {
      fetchCalls.push({ url: "should-not-run", init: {} });
      return new Response("{}");
    };

    const ctrl = new AbortController();
    ctrl.abort();

    const p = new BifrostProvider(baseUrl, apiKey);
    await expect(p.chat({ model: "x", messages: [], signal: ctrl.signal })).rejects.toThrow();
    expect(fetchCalls).toHaveLength(0);
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
