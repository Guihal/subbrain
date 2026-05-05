/**
 * ChatService — PR 26a (LAYER-3) + PR 27 (Repository swap) + W3-10 (split).
 *
 * Owns `/v1/chat/completions`: normalize → direct-mode decide (per-provider
 * via `isOverloadedFor`, PR 23) → persist+hydrate+compress → pipeline vs
 * router → SSE wrap. Route is just TypeBox + headers + `handle()`.
 */

import { logger } from "@subbrain/core/lib/logger";
import { normalizeMessages } from "@subbrain/core/lib/messages";
import { MODEL_MAP, resolveModel } from "@subbrain/core/lib/model-map";
import { maskSecrets } from "@subbrain/core/lib/redact";
import type { ChatRepository, MemoryRepository } from "@subbrain/core/repositories";
import { ProviderError } from "@subbrain/providers";
import type { Message } from "@subbrain/providers/types";
import type { ModelRouter } from "../../lib/model-router";
import type { AgentPipeline } from "../../pipeline";
import { compressContext, shouldCompress } from "../../pipeline/context-compressor";
import type { MemoryService } from "../memory";
import type { ChatCompletionRequest, ChatMeta } from "./meta";
import { compressorMemory, maybeHydrate, persistUser } from "./persist";
import { runDirect, runPipeline } from "./run";

export type { ChatCompletionRequest, ChatMeta } from "./meta";
export { extractChatMeta, sanitizeAgentId } from "./meta";
export { wrapStreamForChat } from "./sse-wrap";

export class ChatService {
  constructor(
    private readonly router: ModelRouter,
    private readonly pipeline: AgentPipeline | undefined,
    private readonly chatRepo: ChatRepository | undefined,
    private readonly memoryRepo: MemoryRepository | undefined,
    /**
     * MEM-2 (M-01): when wired, the compressor persists extracted facts via
     * `MemoryService.insertShared` (embed-first + transactional) instead of
     * raw `MemoryRepository.insertShared`, which left rows without
     * `vec_embeddings`. Optional so legacy test callers
     * (`new ChatService(router, pipeline, undefined)`) keep working.
     */
    private readonly memoryService: MemoryService | undefined = undefined,
  ) {}

  async handle(body: ChatCompletionRequest, meta: ChatMeta): Promise<Response> {
    const stream = body.stream ?? false;
    const { model: requestedModel, messages: rawMessages, ...rest } = body;
    let messages = normalizeMessages(rawMessages as Message[]);

    const { provider: targetProvider } = resolveModel(requestedModel);
    const directMode = meta.directModeForced || this.router.isOverloadedFor(targetProvider);
    // Flash persona is pipeline-only; in direct-mode route upgrades to
    // generalist so user still gets a coherent reply.
    const model = directMode && requestedModel === "flash" ? "generalist" : requestedModel;

    logger.info(
      "chat-service",
      `→ ${model} ${stream ? "stream" : "sync"} ${directMode ? "[direct]" : "[pipeline]"} msgs=${messages.length}`,
      { meta: { direct: directMode, virtual: model in MODEL_MAP } },
    );

    persistUser(this.chatRepo, meta, model, messages);
    messages = maybeHydrate(this.chatRepo, meta, messages);
    if (shouldCompress(messages)) {
      await compressContext(
        messages,
        this.router,
        compressorMemory(this.memoryService, this.memoryRepo),
      );
    }
    const params = { ...rest, messages } as Record<string, unknown>;
    const deps = { router: this.router, pipeline: this.pipeline, chatRepo: this.chatRepo };

    try {
      if (this.pipeline && model in MODEL_MAP && !directMode) {
        return await runPipeline(deps, model, messages, stream, params, meta);
      }
      return await runDirect(deps, model, stream, params, meta);
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
}
