import { Elysia, t } from "elysia";
import { ProviderError } from "../providers";
import type { ModelRouter } from "../lib/model-router";

export function embeddingsRoute(router: ModelRouter) {
  return new Elysia().post(
    "/v1/embeddings",
    async ({ body }) => {
      try {
        return await router.scheduleRaw("normal", () => router.raw.embed(body));
      } catch (err) {
        if (err instanceof ProviderError) {
          return new Response(
            JSON.stringify({
              error: {
                message: err.body,
                type: "upstream_error",
                code: err.status,
              },
            }),
            {
              status: err.status,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        throw err;
      }
    },
    {
      body: t.Object({
        model: t.String(),
        input: t.Union([t.String(), t.Array(t.String())]),
        encoding_format: t.Optional(t.String()),
        input_type: t.Optional(t.String()),
      }),
    },
  );
}
