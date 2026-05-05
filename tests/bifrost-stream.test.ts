import { describe, expect, test } from "bun:test";
import { BifrostProvider } from "../src/providers/bifrost";

describe("BifrostProvider.chatStream", () => {
  const baseUrl = "http://bifrost:8080";
  const apiKey = "sk-bifrost-test-key-very-long-12345";

  function buildSseResponse(chunks: string[], status = 200) {
    const encoder = new TextEncoder();
    let index = 0;
    return new Response(
      new ReadableStream({
        pull(controller) {
          if (index >= chunks.length) {
            controller.close();
            return;
          }
          controller.enqueue(encoder.encode(chunks[index]));
          index++;
        },
      }),
      { status, headers: { "Content-Type": "text/event-stream" } },
    );
  }

  test("proxies SSE chunks byte-for-byte", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
      "data: [DONE]\n\n",
    ];
    globalThis.fetch = async () => buildSseResponse(chunks);

    const p = new BifrostProvider(baseUrl, apiKey);
    const stream = p.chatStream({ model: "gpt-4", messages: [] });
    const reader = stream.getReader();
    const out: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      out.push(value);
    }

    const text = new TextDecoder().decode(Buffer.concat(out.map((b) => Buffer.from(b))));
    expect(text).toContain('"content":"hello"');
    expect(text).toContain('"content":" world"');
    expect(text).toContain("data: [DONE]");
  });

  test("upstream 5xx emits error chunk + [DONE]", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: "boom" }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });

    const p = new BifrostProvider(baseUrl, apiKey);
    const stream = p.chatStream({ model: "x", messages: [] });
    const reader = stream.getReader();
    const out: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      out.push(value);
    }

    const text = new TextDecoder().decode(Buffer.concat(out.map((b) => Buffer.from(b))));
    expect(text).toContain("502");
    expect(text).toContain("data: [DONE]");
  });

  test("pre-flight abort emits error chunk without fetch", async () => {
    let fetchCalled = 0;
    globalThis.fetch = async () => {
      fetchCalled++;
      return new Response("{}");
    };

    const ctrl = new AbortController();
    ctrl.abort();

    const p = new BifrostProvider(baseUrl, apiKey);
    const stream = p.chatStream({ model: "x", messages: [], signal: ctrl.signal });
    const reader = stream.getReader();
    const out: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      out.push(value);
    }

    expect(fetchCalled).toBe(0);
    const text = new TextDecoder().decode(Buffer.concat(out.map((b) => Buffer.from(b))));
    expect(text).toContain("data: [DONE]");
  });
});
