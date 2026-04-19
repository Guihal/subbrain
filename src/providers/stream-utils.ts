/**
 * Shared streaming utilities for LLM providers.
 * Eliminates duplication between NvidiaProvider and CopilotProvider.
 */

/**
 * Creates a ReadableStream that proxies a fetch SSE response.
 * On error, emits an SSE error event and [DONE] marker for clean client handling.
 */
export function createProxyStream(
  fetchFn: () => Promise<Response>,
  timeoutMs = 180_000,
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      const emitError = (msg: string, type = "stream_error") => {
        try {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ error: { message: msg, type } })}\n\n`,
            ),
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch {
          // Controller already closed
        }
      };

      try {
        const res = await fetchFn();

        if (!res.ok) {
          const text = await res.text();
          console.error(`[stream-utils] upstream error ${res.status}: ${text.slice(0, 300)}`);
          emitError(text, "upstream_error");
          return;
        }

        const reader = res.body?.getReader();
        if (!reader) {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
          return;
        }

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
        controller.close();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        emitError(msg);
      }
    },
  });
}
