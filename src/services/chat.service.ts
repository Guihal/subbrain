/**
 * ChatService — PR 26a (LAYER-3) + PR 27 (Repository swap).
 *
 * Owns `/v1/chat/completions`: normalize → direct-mode decide (per-provider
 * via `isOverloadedFor`, PR 23) → persist+hydrate+compress → pipeline vs
 * router → SSE wrap. Route (`src/routes/chat.ts`) is just TypeBox + headers
 * + `handle()`.
 *
 * PR 27: ctor takes `ChatRepository` (+ `MemoryRepository` for compressor
 * fact-persist) instead of the `MemoryDB` god-object. `wrapStreamForChat`
 * honors `isClosed` (§5) — no DB write after client cancel.
 */
import { ProviderError } from "../providers";
import { sseResponse } from "../lib/sse";
import { MODEL_MAP, resolveModel } from "../lib/model-map";
import { normalizeMessages } from "../lib/messages";
import {
  shouldCompress,
  compressContext,
  type CompressorMemory,
} from "../pipeline/context-compressor";
import type { ModelRouter } from "../lib/model-router";
import type { AgentPipeline } from "../pipeline";
import type { ChatRepository, MemoryRepository } from "../repositories";
import type { MemoryService } from "./memory.service";
import type { Message } from "../providers/types";
import { logger } from "../lib/logger";
import { maskSecrets } from "../lib/redact";
import { parseSSEChunk } from "../providers/sse-parser";

export interface ChatCompletionRequest {
  model: string;
  messages: unknown[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stream?: boolean;
  tools?: unknown;
  tool_choice?: unknown;
  [extra: string]: unknown;
}

export interface ChatMeta {
  chatId?: string;
  source: string;
  sessionId?: string;
  directModeForced: boolean;
  /**
   * B-1: optional `x-agent-id` header. Trust model: every authenticated
   * caller (single shared bearer token) is admin-grade, so this header is
   * an admin-controlled scoping primitive — it does not grant new access,
   * it narrows what the agent-loop sees from the shared context store.
   * Validated to a strict charset/length so a hostile token-holder cannot
   * inject arbitrary strings into `layer2_context.agent_id`.
   */
  agentId: string | null;
}

/**
 * B-1: validated identifier for `layer2_context.agent_id` and friends.
 *
 * Lowercase-normalize after match — prevents two parallel buckets ("Alice"
 * vs "alice") that would silently break read/write symmetry under the
 * `(c.agent_id = ? OR c.agent_id IS NULL)` filter.
 */
const AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export function sanitizeAgentId(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const v = raw.trim();
  if (!v) return null;
  if (!AGENT_ID_RE.test(v)) return null;
  return v.toLowerCase();
}

export function extractChatMeta(h: Record<string, string | undefined>): ChatMeta {
  return {
    chatId: h["x-chat-id"],
    source: h["x-chat-source"] || "api",
    sessionId: h["x-session-id"],
    directModeForced: h["x-direct-mode"] === "true",
    agentId: sanitizeAgentId(h["x-agent-id"]),
  };
}

export class ChatService {
  constructor(
    private readonly router: ModelRouter,
    private readonly pipeline: AgentPipeline | undefined,
    private readonly chatRepo: ChatRepository | undefined,
    private readonly memoryRepo: MemoryRepository | undefined,
    /**
     * MEM-2 (M-01): when wired, the compressor persists extracted facts
     * through `MemoryService.insertShared` (embed-first + transactional)
     * instead of the raw `MemoryRepository.insertShared` it previously used,
     * which left rows without `vec_embeddings`. Optional so legacy test
     * callers (`new ChatService(router, pipeline, undefined)`) keep working.
     */
    private readonly memoryService: MemoryService | undefined = undefined,
  ) {}

  async handle(body: ChatCompletionRequest, meta: ChatMeta): Promise<Response> {
    const stream = body.stream ?? false;
    const { model: requestedModel, messages: rawMessages, ...rest } = body;
    let messages = normalizeMessages(rawMessages as Message[]);

    const { provider: targetProvider } = resolveModel(requestedModel);
    const directMode =
      meta.directModeForced || this.router.isOverloadedFor(targetProvider);
    // Flash persona is pipeline-only; in direct-mode route upgrades to
    // generalist so user still gets a coherent reply.
    const model =
      directMode && requestedModel === "flash" ? "generalist" : requestedModel;

    logger.info(
      "chat-service",
      `→ ${model} ${stream ? "stream" : "sync"} ${directMode ? "[direct]" : "[pipeline]"} msgs=${messages.length}`,
      { meta: { direct: directMode, virtual: model in MODEL_MAP } },
    );

    this.persistUser(meta, model, messages);
    messages = this.maybeHydrate(meta, messages);
    if (shouldCompress(messages)) {
      await compressContext(messages, this.router, this.compressorMemory());
    }
    const params = { ...rest, messages } as Record<string, unknown>;

    try {
      if (this.pipeline && model in MODEL_MAP && !directMode) {
        return await this.runPipeline(model, messages, stream, params, meta);
      }
      return await this.runDirect(model, stream, params, meta);
    } catch (err) {
      if (err instanceof ProviderError) {
        const redacted = maskSecrets(String(err.body)).slice(0, 200);
        logger.error("chat-service", `Provider error: ${err.status} ${redacted}`, { model });
        return new Response(
          JSON.stringify({
            error: { message: redacted, type: "upstream_error", code: err.status },
          }),
          { status: err.status, headers: { "Content-Type": "application/json" } },
        );
      }
      throw err;
    }
  }

  private async runPipeline(
    model: string, messages: Message[], stream: boolean,
    params: Record<string, unknown>, meta: ChatMeta,
  ): Promise<Response> {
    const pipeline = this.pipeline;
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
        this.chatRepo && meta.chatId
          ? wrapStreamForChat(result.stream, this.chatRepo, meta.chatId, model, result.requestId)
          : result.stream;
      return sseResponse(out);
    }
    if (result.response) {
      const msg = result.response.choices?.[0]?.message;
      const assistantContent = msg?.content ?? "";
      if (this.chatRepo && meta.chatId && assistantContent) {
        this.chatRepo.appendChatMessage(meta.chatId, "assistant", assistantContent, {
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

  private async runDirect(
    model: string, stream: boolean, params: Record<string, unknown>, meta: ChatMeta,
  ): Promise<Response> {
    if (stream) {
      const s = await this.router.chatStream(model, params as never);
      const wrapped =
        this.chatRepo && meta.chatId ? wrapStreamForChat(s, this.chatRepo, meta.chatId, model) : s;
      return sseResponse(wrapped);
    }
    const response = await this.router.chat(model, params as never);
    const assistantMsg = response.choices?.[0]?.message?.content ?? "";
    if (this.chatRepo && meta.chatId && assistantMsg) {
      this.chatRepo.appendChatMessage(meta.chatId, "assistant", assistantMsg, { model });
    }
    return new Response(JSON.stringify(response), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private persistUser(meta: ChatMeta, model: string, messages: Message[]): void {
    if (!this.chatRepo || !meta.chatId) return;
    const lastUserMsg = messages.filter((m) => m.role === "user").pop();
    if (!lastUserMsg?.content) return;
    const existing = this.chatRepo.getChat(meta.chatId);
    if (!existing) {
      this.chatRepo.createChat(meta.chatId, lastUserMsg.content.slice(0, 80), model, meta.source);
    } else if (existing.model !== model) {
      this.chatRepo.updateChatModel(meta.chatId, model);
    }
    this.chatRepo.appendChatMessage(meta.chatId, "user", lastUserMsg.content);
  }

  /**
   * MEM-2 (M-01): pick the strongest available `insertShared` for the
   * compressor. Service shim → embed-first + transactional. memoryRepo →
   * raw insert without vec (back-compat for older tests). null → drop facts.
   */
  private compressorMemory(): CompressorMemory | null {
    if (this.memoryService) {
      const svc = this.memoryService;
      return {
        insertShared: (
          _id: string,
          category: string,
          content: string,
          tags?: string,
          source?: string,
          opts?: { confidence?: number | null; status?: import("../db").MemoryStatus },
        ) => svc.insertShared({
          category,
          content,
          tags: tags ?? "",
          source,
          confidence: opts?.confidence,
          status: opts?.status,
        }),
      };
    }
    return this.memoryRepo ?? null;
  }

  private maybeHydrate(meta: ChatMeta, messages: Message[]): Message[] {
    if (!this.chatRepo || !meta.chatId) return messages;
    if (messages.some((m) => m.role === "assistant")) return messages;
    const stored = this.chatRepo.getChatMessages(meta.chatId);
    if (stored.length <= messages.filter((m) => m.role !== "system").length) return messages;
    const systems = messages.filter((m) => m.role === "system");
    const history: Message[] = stored.map((r) => ({ role: r.role as Message["role"], content: r.content }));
    logger.info("chat-service", `hydrated history from chats: ${history.length} msgs`, { meta: { chatId: meta.chatId } });
    return [...systems, ...history];
  }
}

export function wrapStreamForChat(
  stream: ReadableStream<Uint8Array>,
  chatRepo: ChatRepository,
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
      if (isClosed) return; // client disconnected mid-stream
      if (fullContent) {
        chatRepo.appendChatMessage(chatId, "assistant", fullContent, {
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
