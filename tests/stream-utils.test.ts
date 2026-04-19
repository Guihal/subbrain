/**
 * Tests for createProxyStream (src/providers/stream-utils.ts).
 */
import { describe, test, expect } from "bun:test";
import { createProxyStream } from "../src/providers/stream-utils";

/** Collect all chunks from a stream into a single string */
async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  return result;
}

describe("createProxyStream", () => {
  test("proxies successful SSE response", async () => {
    const payload = 'data: {"id":"1","choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';
    const fakeResponse = new Response(payload, { status: 200 });
    const stream = createProxyStream(() => Promise.resolve(fakeResponse));
    const text = await drain(stream);
    expect(text).toContain('"content":"hi"');
    expect(text).toContain("[DONE]");
  });

  test("emits error frame on non-200 response", async () => {
    const fakeResponse = new Response("Rate limit exceeded", { status: 429 });
    const stream = createProxyStream(() => Promise.resolve(fakeResponse));
    const text = await drain(stream);
    expect(text).toContain("Rate limit exceeded");
    expect(text).toContain("upstream_error");
    expect(text).toContain("[DONE]");
  });

  test("emits error frame on fetch failure", async () => {
    const stream = createProxyStream(() =>
      Promise.reject(new Error("Network failure")),
    );
    const text = await drain(stream);
    expect(text).toContain("Network failure");
    expect(text).toContain("stream_error");
    expect(text).toContain("[DONE]");
  });

  test("handles empty body gracefully", async () => {
    const fakeResponse = new Response(null, { status: 200 });
    // Override body to null
    Object.defineProperty(fakeResponse, "body", { value: null });
    const stream = createProxyStream(() => Promise.resolve(fakeResponse));
    const text = await drain(stream);
    expect(text).toContain("[DONE]");
  });

  test("multi-chunk streaming preserves all data", async () => {
    const chunks = [
      'data: {"chunk":1}\n\n',
      'data: {"chunk":2}\n\n',
      'data: {"chunk":3}\n\n',
      "data: [DONE]\n\n",
    ];
    const encoder = new TextEncoder();
    const readable = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });
    const fakeResponse = new Response(readable, { status: 200 });
    const stream = createProxyStream(() => Promise.resolve(fakeResponse));
    const text = await drain(stream);
    expect(text).toContain('"chunk":1');
    expect(text).toContain('"chunk":2');
    expect(text).toContain('"chunk":3');
    expect(text).toContain("[DONE]");
  });

  test("non-Error throw handled gracefully", async () => {
    const stream = createProxyStream(() => Promise.reject("string error"));
    const text = await drain(stream);
    expect(text).toContain("string error");
    expect(text).toContain("[DONE]");
  });
});

console.log("🎉 Stream utils tests passed!");
