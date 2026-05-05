import type { ModelRouter } from "../../lib/model-router";
import { sseResponse } from "../../lib/sse";
import type { AgentPipeline } from "../../pipeline";
import type { Message } from "../../providers/types";
import type { ChatRepository } from "../../repositories";
import type { ChatMeta } from "./meta";
import { wrapStreamForChat } from "./sse-wrap";

export interface RunDeps {
  router: ModelRouter;
  pipeline: AgentPipeline | undefined;
  chatRepo: ChatRepository | undefined;
}

export async function runPipeline(
  deps: RunDeps,
  model: string,
  messages: Message[],
  stream: boolean,
  params: Record<string, unknown>,
  meta: ChatMeta,
): Promise<Response> {
  const pipeline = deps.pipeline;
  if (!pipeline) throw new Error("pipeline required");
  const result = await pipeline.execute({
    model,
    messages,
    stream,
    sessionId: meta.sessionId,
    temperature: params.temperature as number | undefined,
    max_tokens: params.max_tokens as number | undefined,
    top_p: params.top_p as number | undefined,
    tools: params.tools as unknown[] | undefined,
    tool_choice: params.tool_choice,
    agentId: meta.agentId,
  });
  if (result.stream) {
    const out =
      deps.chatRepo && meta.chatId
        ? wrapStreamForChat(result.stream, deps.chatRepo, meta.chatId, model, result.requestId)
        : result.stream;
    return sseResponse(out);
  }
  if (result.response) {
    const msg = result.response.choices?.[0]?.message;
    const assistantContent = msg?.content ?? "";
    if (deps.chatRepo && meta.chatId && assistantContent) {
      deps.chatRepo.appendChatMessage(meta.chatId, "assistant", assistantContent, {
        reasoning: msg?.reasoning_content || undefined,
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
  throw new Error("pipeline returned neither stream nor response");
}

export async function runDirect(
  deps: RunDeps,
  model: string,
  stream: boolean,
  params: Record<string, unknown>,
  meta: ChatMeta,
): Promise<Response> {
  if (stream) {
    const s = await deps.router.chatStream(model, params as never);
    const wrapped =
      deps.chatRepo && meta.chatId ? wrapStreamForChat(s, deps.chatRepo, meta.chatId, model) : s;
    return sseResponse(wrapped);
  }
  const response = await deps.router.chat(model, params as never);
  const assistantMsg = response.choices?.[0]?.message?.content ?? "";
  if (deps.chatRepo && meta.chatId && assistantMsg) {
    deps.chatRepo.appendChatMessage(meta.chatId, "assistant", assistantMsg, { model });
  }
  return new Response(JSON.stringify(response), {
    headers: { "Content-Type": "application/json" },
  });
}
