import type { ModelTarget, ProviderName } from "@subbrain/core/lib/model-map";
import { ProviderError } from "../nvidia";
import type { ChatParams } from "../types";
import type { Backend } from "./constants";

export function createFallbackStream(
  backends: Record<ProviderName, Backend>,
  primary: ModelTarget,
  fallback: ModelTarget | null,
  params: Omit<ChatParams, "model">,
  handleProviderError: (err: ProviderError, provider: ProviderName) => void,
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      const tryModel = async (target: ModelTarget): Promise<boolean> => {
        try {
          const backend = backends[target.provider] ?? backends.nvidia;
          const stream = backend.provider.chatStream({
            ...params,
            model: target.model,
          });
          const reader = stream.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
          return true;
        } catch (err) {
          if (err instanceof ProviderError) {
            handleProviderError(err, target.provider);
          }
          return false;
        }
      };

      let ok = false;
      try {
        ok = await tryModel(primary);
        if (!ok && fallback) {
          ok = await tryModel(fallback);
        }

        if (!ok) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ error: { message: "All models failed" } })}\n\n`,
            ),
          );
        }
      } catch (err) {
        // Cap msg to 500 chars — provider error bodies can be multi-MB HTML
        // pages and would otherwise be re-encoded into the client SSE stream.
        const rawMsg = err instanceof Error ? err.message : String(err);
        const msg = rawMsg.slice(0, 500);
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ error: { message: msg, type: "router_error" } })}\n\n`,
          ),
        );
      }

      // Only emit DONE if upstream didn't (error cases). Successful streams already include [DONE].
      if (!ok) {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      }
      controller.close();
    },
  });
}
