import { Elysia, t } from "elysia";
import { ProviderError } from "../providers";
import { sseResponse } from "../lib/sse";
import { MODEL_MAP } from "../lib/model-map";
import type { ModelRouter } from "../lib/model-router";
import type { AgentPipeline } from "../pipeline";
import type { MemoryDB } from "../db";
import type { Message } from "../providers/types";
import { logger } from "../lib/logger";

export function chatRoute(
  router: ModelRouter,
  pipeline?: AgentPipeline,
  memory?: MemoryDB,
) {
  return new Elysia().post(
    "/v1/chat/completions",
    async ({ body, headers }) => {
      const stream = body.stream ?? false;
      const { model, ...rest } = body;

      // Chat persistence: use X-Chat-Id header if provided
      const chatId = headers["x-chat-id"] as string | undefined;
      const source = (headers["x-chat-source"] as string) || "api";

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

      // ─── Persist user message to chat ──────────────────
      const lastUserMsg = rest.messages
        .filter((m: any) => m.role === "user")
        .pop();
      if (memory && chatId && lastUserMsg?.content) {
        // Ensure chat exists
        const existing = memory.getChat(chatId);
        if (!existing) {
          const title = (lastUserMsg.content as string).slice(0, 80);
          memory.createChat(chatId, title, model, source);
        } else if (existing.model !== model) {
          memory.updateChatModel(chatId, model);
        }
        memory.appendChatMessage(chatId, "user", lastUserMsg.content as string);
      }

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
            // For streaming: wrap stream to capture assistant response
            if (memory && chatId) {
              const wrappedStream = wrapStreamForChat(
                result.stream,
                memory,
                chatId,
                model,
                result.requestId,
              );
              return sseResponse(wrappedStream);
            }
            return sseResponse(result.stream);
          }

          // Attach request_id in response header for traceability
          if (result.response) {
            const assistantContent =
              result.response.choices?.[0]?.message?.content || "";
            const reasoning = (result.response.choices?.[0]?.message as any)
              ?.reasoning_content;
            if (memory && chatId && assistantContent) {
              memory.appendChatMessage(chatId, "assistant", assistantContent, {
                reasoning: reasoning || undefined,
                model,
                requestId: result.requestId,
              });
            }
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
          if (memory && chatId) {
            return sseResponse(
              wrapStreamForChat(streamResult, memory, chatId, model),
            );
          }
          return sseResponse(streamResult);
        }

        const response = await router.chat(model, rest);
        const assistantMsg = response.choices?.[0]?.message?.content || "";
        if (memory && chatId && assistantMsg) {
          memory.appendChatMessage(chatId, "assistant", assistantMsg, {
            model,
          });
        }
        return response;
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
            content: t.Optional(t.Union([t.String(), t.Null(), t.Array(t.Any())])),
            name: t.Optional(t.String()),
            tool_calls: t.Optional(t.Any()),
            tool_call_id: t.Optional(t.String()),
          }, { additionalProperties: true }),
        ),
        temperature: t.Optional(t.Number()),
        max_tokens: t.Optional(t.Number()),
        top_p: t.Optional(t.Number()),
        stream: t.Optional(t.Boolean()),
        tools: t.Optional(t.Any()),
        tool_choice: t.Optional(t.Any()),
      }, { additionalProperties: true }),
    },
  );
}

/**
 * Wraps an SSE stream to capture the full assistant response
 * and persist it to the chats table when the stream ends.
 */
function wrapStreamForChat(
  stream: ReadableStream<Uint8Array>,
  memory: MemoryDB,
  chatId: string,
  model: string,
  requestId?: string,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let fullContent = "";
  let fullReasoning = "";
  let buffer = "";

  return new ReadableStream({
    async start(controller) {
      const reader = stream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);

          // Parse SSE to capture content
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const payload = line.slice(6).trim();
            if (payload === "[DONE]") continue;
            try {
              const chunk = JSON.parse(payload);
              const delta = chunk.choices?.[0]?.delta;
              if (delta?.content) fullContent += delta.content;
              if (delta?.reasoning_content)
                fullReasoning += delta.reasoning_content;
            } catch {}
          }
        }

        // Stream done — save to DB
        if (fullContent) {
          memory.appendChatMessage(chatId, "assistant", fullContent, {
            reasoning: fullReasoning || undefined,
            model,
            requestId,
          });
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}
