import { Elysia, t } from "elysia";
import { ProviderError } from "../providers";
import { sseResponse } from "../lib/sse";
import { MODEL_MAP } from "../lib/model-map";
import { normalizeMessages } from "../lib/messages";
import { shouldCompress, compressContext } from "../pipeline/context-compressor";
import type { ModelRouter } from "../lib/model-router";
import type { AgentPipeline } from "../pipeline";
import type { MemoryDB } from "../db";
import { logger } from "../lib/logger";
import { parseSSEChunk } from "../providers/sse-parser";

export function chatRoute(
  router: ModelRouter,
  pipeline?: AgentPipeline,
  memory?: MemoryDB,
) {
  return new Elysia().post(
    "/v1/chat/completions",
    async ({ body, headers }) => {
      const stream = body.stream ?? false;
      const { model, messages: rawMessages, ...rest } = body;
      const messages = normalizeMessages(rawMessages);

      // Compress long chat histories before forwarding. Inbound client sends
      // the full history each turn, so this is the only chance to trim it.
      if (shouldCompress(messages)) {
        await compressContext(messages, router, memory ?? null);
      }

      const params = { ...rest, messages };

      // Chat persistence: use X-Chat-Id header if provided
      const chatId = headers["x-chat-id"] as string | undefined;
      const source = (headers["x-chat-source"] as string) || "api";

      // Direct mode: explicit header OR auto-degrade when RPM overloaded
      const directMode =
        headers["x-direct-mode"] === "true" || router.isOverloaded;

      const isVirtual = model in MODEL_MAP;
      logger.info(
        "route",
        `→ ${model} ${stream ? "stream" : "sync"} ${directMode ? "[direct]" : "[pipeline]"} msgs=${messages.length}`,
        {
          meta: { direct: directMode, virtual: isVirtual },
        },
      );

      // ─── Persist user message to chat ──────────────────
      const lastUserMsg = messages.filter((m) => m.role === "user").pop();
      if (memory && chatId && lastUserMsg?.content) {
        // Ensure chat exists
        const existing = memory.getChat(chatId);
        if (!existing) {
          const title = lastUserMsg.content.slice(0, 80);
          memory.createChat(chatId, title, model, source);
        } else if (existing.model !== model) {
          memory.updateChatModel(chatId, model);
        }
        memory.appendChatMessage(chatId, "user", lastUserMsg.content);
      }

      try {
        // If pipeline is available, model is a virtual role, and NOT direct mode
        if (pipeline && model in MODEL_MAP && !directMode) {
          const result = await pipeline.execute({
            model,
            messages,
            stream,
            sessionId: headers["x-session-id"] as string | undefined,
            temperature: params.temperature,
            max_tokens: params.max_tokens,
            top_p: params.top_p,
            tools: params.tools,
            tool_choice: params.tool_choice,
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
          const streamResult = await router.chatStream(model, params);
          if (memory && chatId) {
            return sseResponse(
              wrapStreamForChat(streamResult, memory, chatId, model),
            );
          }
          return sseResponse(streamResult);
        }

        const response = await router.chat(model, params);
        const assistantMsg = response.choices?.[0]?.message?.content || "";
        if (memory && chatId && assistantMsg) {
          memory.appendChatMessage(chatId, "assistant", assistantMsg, {
            model,
          });
        }
        return response;
      } catch (err) {
        if (err instanceof ProviderError) {
          // Cap body + redact api_key: provider bodies can be huge HTML pages
          // and may echo the forwarded Authorization header.
          const redactedBody = String(err.body)
            .slice(0, 200)
            .replace(/api[_-]?key/gi, "***");
          logger.error(
            "route",
            `Provider error: ${err.status} ${redactedBody}`,
            { model },
          );
          return new Response(
            JSON.stringify({
              error: {
                message: redactedBody,
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
            role: t.Union([
              t.Literal("system"),
              t.Literal("user"),
              t.Literal("assistant"),
              t.Literal("tool"),
            ]),
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
export function wrapStreamForChat(
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
  let isClosed = false;
  let innerReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  return new ReadableStream({
    async start(controller) {
      innerReader = stream.getReader();
      try {
        while (true) {
          const { done, value } = await innerReader.read();
          if (done || isClosed) break;
          controller.enqueue(value);

          // Parse SSE to capture content
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            const delta = parseSSEChunk(line);
            if (!delta) continue;
            if (delta.content) fullContent += delta.content;
            if (delta.reasoning_content) fullReasoning += delta.reasoning_content;
          }
        }
      } catch (err) {
        if (!isClosed) controller.error(err);
        return;
      }
      // Client disconnected mid-stream — don't write a truncated message.
      if (isClosed) return;
      if (fullContent) {
        memory.appendChatMessage(chatId, "assistant", fullContent, {
          reasoning: fullReasoning || undefined,
          model,
          requestId,
        });
      }
      controller.close();
    },
    cancel(reason) {
      isClosed = true;
      innerReader?.cancel(reason).catch(() => {});
    },
  });
}
