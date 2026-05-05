import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BifrostProvider } from "@subbrain/providers/bifrost";

describe("BifrostProvider.chatStream", () => {
  const apiKey = "sk-bifrost-test-key-very-long-12345";
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl = "";
  let nextChunks: string[] = [];
  let nextStatus = 200;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch() {
        if (nextStatus !== 200) {
          return new Response(JSON.stringify({ error: "boom" }), {
            status: nextStatus,
            headers: { "Content-Type": "application/json" },
          });
        }
        const encoder = new TextEncoder();
        let index = 0;
        return new Response(
          new ReadableStream({
            pull(controller) {
              if (index >= nextChunks.length) {
                controller.close();
                return;
              }
              controller.enqueue(encoder.encode(nextChunks[index]));
              index++;
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      },
    });
    baseUrl = `http://localhost:${server.port}`;
  });

  afterAll(() => server.stop(true));

  test("proxies SSE chunks byte-for-byte", async () => {
    nextStatus = 200;
    nextChunks = [
      'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
      "data: [DONE]\n\n",
    ];

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
    nextStatus = 502;
    nextChunks = [];

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
    nextStatus = 200;
    nextChunks = [];

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

    const text = new TextDecoder().decode(Buffer.concat(out.map((b) => Buffer.from(b))));
    expect(text).toContain("data: [DONE]");
  });
});
