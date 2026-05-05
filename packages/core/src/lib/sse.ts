/**
 * Wraps a ReadableStream<Uint8Array> (SSE from upstream) into a Response
 * suitable for Elysia with correct headers.
 *
 * NOTE: `Connection: keep-alive` is HTTP/1.1-only and MUST NOT be sent over
 * HTTP/2 — it causes ERR_HTTP2_PROTOCOL_ERROR in browsers and proxies.
 */
export function sseResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      "Content-Encoding": "identity",
    },
  });
}
