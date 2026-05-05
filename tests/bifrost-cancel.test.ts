import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BifrostProvider } from "@subbrain/providers/bifrost";

describe("BifrostProvider.chatStream mid-flight cancel", () => {
  const apiKey = "sk-bifrost-test-key-very-long-12345";
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl = "";

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch() {
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'),
              );
              // Keep stream open until client aborts
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      },
    });
    baseUrl = `http://localhost:${server.port}`;
  });

  afterAll(() => server.stop(true));

  test("abort after first chunk emits error + [DONE]", async () => {
    const ctrl = new AbortController();
    const p = new BifrostProvider(baseUrl, apiKey);
    const stream = p.chatStream({ model: "x", messages: [], signal: ctrl.signal });
    const reader = stream.getReader();
    const out: Uint8Array[] = [];

    const first = await reader.read();
    if (!first.done && first.value) out.push(first.value);
    ctrl.abort();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      out.push(value);
    }

    const text = new TextDecoder().decode(Buffer.concat(out.map((b) => Buffer.from(b))));
    expect(text).toContain('"content":"hi"');
    expect(text).toContain("stream_error");
    expect(text).toContain("data: [DONE]");
  });
});
