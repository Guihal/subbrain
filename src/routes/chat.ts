import { Elysia, t } from "elysia";
import { ProviderError } from "../providers";
import { sseResponse } from "../lib/sse";
import { MODEL_MAP } from "../lib/model-map";
import type { ModelRouter } from "../lib/model-router";
import type { AgentPipeline } from "../pipeline";
import type { Message } from "../providers/types";
import { logger } from "../lib/logger";

export function chatRoute(router: ModelRouter, pipeline?: AgentPipeline) {
  return new Elysia().post(
    "/v1/chat/completions",
    async ({ body, headers }) => {
      const stream = body.stream ?? false;
      const { model, ...rest } = body;

      // Direct mode: explicit header OR auto-degrade when RPM overloaded
      const directMode =
        headers["x-direct-mode"] === "true" || router.isOverloaded;

      const isVirtual = model in MODEL_MAP;
      logger.info(
        "route",
        `→ ${model} ${stream ? "stream" : "sync"} ${directMode ? "[direct]" : "[pipeline]"} msgs=${rest.messages.length}`,
        {
          meta: { direct: directMode, virtual: isVirtual },
        },
      );

      try {
        // If pipeline is available, model is a virtual role, and NOT direct mode
        if (pipeline && model in MODEL_MAP && !directMode) {
          const result = await pipeline.execute({
            model,
            messages: rest.messages as Message[],
            stream,
            sessionId: headers["x-session-id"] as string | undefined,
            temperature: rest.temperature,
            max_tokens: rest.max_tokens,
            top_p: rest.top_p,
            tools: rest.tools,
            tool_choice: rest.tool_choice,
          });

          if (result.stream) {
            return sseResponse(result.stream);
          }

          // Attach request_id in response header for traceability
          if (result.response) {
            return new Response(JSON.stringify(result.response), {
              headers: {
                "Content-Type": "application/json",
                "X-Request-Id": result.requestId,
                "X-Session-Id": result.sessionId,
              },
            });
          }
        }

        // Direct proxy mode (no pipeline, or unknown real model)
        if (stream) {
          const streamResult = await router.chatStream(model, rest);
          return sseResponse(streamResult);
        }

        return await router.chat(model, rest);
      } catch (err) {
        if (err instanceof ProviderError) {
          logger.error(
            "route",
            `Provider error: ${err.status} ${err.body.slice(0, 200)}`,
            { model },
          );
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
        messages: t.Array(
          t.Object({
            role: t.String(),
            content: t.Union([t.String(), t.Null()]),
            tool_calls: t.Optional(t.Any()),
            tool_call_id: t.Optional(t.String()),
          }),
        ),
        temperature: t.Optional(t.Number()),
        max_tokens: t.Optional(t.Number()),
        top_p: t.Optional(t.Number()),
        stream: t.Optional(t.Boolean()),
        tools: t.Optional(t.Any()),
        tool_choice: t.Optional(t.Any()),
      }),
    },
  );
}
