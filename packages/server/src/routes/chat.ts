import type { AgentPipeline } from "@subbrain/agent/pipeline";
import {
  type ChatCompletionRequest,
  ChatService,
  extractChatMeta,
  wrapStreamForChat,
} from "@subbrain/agent/services/chat";
import type { MemoryDB } from "@subbrain/core/db";
import type { ModelRouter } from "@subbrain/core/lib/model-router";
import { Elysia, t } from "elysia";

// Re-export so legacy importers (e.g. tests/chat-stream.test.ts) keep working
// after the PR 26a move into `services/chat.service.ts`.
export { wrapStreamForChat };

/**
 * Thin Elysia factory (PR 26a). Owns the TypeBox schema + header extraction
 * only; all request orchestration lives in `ChatService`.
 *
 * Signature stays `(router, pipeline?, memory?)` so pre-refactor tests
 * (`chat-direct-mode.test.ts`, `chat-continuity.test.ts`) keep compiling.
 * `src/app/deps.ts` wires the long-lived service; this factory is cheap
 * enough to rebuild one per call, and tests need a simple constructor.
 */
export function chatRoute(router: ModelRouter, pipeline?: AgentPipeline, memory?: MemoryDB) {
  const service = new ChatService(router, pipeline, memory?.chatRepo, memory?.memoryRepo);
  return new Elysia().post(
    "/v1/chat/completions",
    ({ body, headers }) => service.handle(body as ChatCompletionRequest, extractChatMeta(headers)),
    {
      body: t.Object(
        {
          model: t.String(),
          messages: t.Array(
            t.Object(
              {
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
              },
              { additionalProperties: true },
            ),
          ),
          temperature: t.Optional(t.Number()),
          max_tokens: t.Optional(t.Number()),
          top_p: t.Optional(t.Number()),
          stream: t.Optional(t.Boolean()),
          tools: t.Optional(t.Any()),
          tool_choice: t.Optional(t.Any()),
        },
        { additionalProperties: true },
      ),
    },
  );
}
