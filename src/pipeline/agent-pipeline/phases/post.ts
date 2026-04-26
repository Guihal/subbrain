/**
 * Post-processing phase: appendLog (Layer 4) + gated agentic extraction.
 *
 * - `runPost` is called from non-stream paths (response already materialized).
 * - `runPostFromStream` consumes a captured SSE stream, decodes it to plain text,
 *   then delegates to `runPost`. Used by the streaming pipeline path.
 */
import type { MemoryDB } from "../../../db";
import type { ModelRouter } from "../../../lib/model-router";
import type { RAGPipeline } from "../../../rag";
import type { ToolExecutor } from "../../../mcp";
import type { ToolRegistry } from "../../../mcp/registry";
import { logger, type RequestLogger } from "../../../lib/logger";
import { parseSSEChunk } from "../../../providers/sse-parser";

import { shouldRunHippocampus } from "../post/gate";
import { runHippocampus } from "../post/hippocampus";

export interface RunPostArgs {
  memory: MemoryDB;
  router: ModelRouter;
  rag: RAGPipeline;
  executor: ToolExecutor;
  registry: ToolRegistry;
  userMessage: string;
  assistantMessage: string;
  requestId: string;
  sessionId: string;
  model: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  reasoning?: string;
  options?: { skipRawLog?: boolean };
  /** B-1: per-agent identity used to scope context-layer writes; null = no scope. */
  agentId?: string | null;
}

export async function runPost(args: RunPostArgs): Promise<void> {
  const {
    memory, router, rag, executor, registry,
    userMessage, assistantMessage, requestId, sessionId, model,
    usage, reasoning, options, agentId,
  } = args;

  const log = logger.forRequest(requestId, sessionId);
  log.info(
    "post",
    `Post-processing: user=${userMessage.length}ch assistant=${assistantMessage.length}ch`,
    { model },
  );

  // 1. Layer 4 raw log unless caller already wrote it.
  if (!options?.skipRawLog) {
    memory.appendLog(requestId, sessionId, model, "user", userMessage);
    memory.appendLog(
      requestId,
      sessionId,
      model,
      "assistant",
      assistantMessage,
      usage?.completion_tokens,
    );
    if (reasoning && reasoning.length > 0) {
      memory.appendLog(requestId, sessionId, model, "reasoning", reasoning);
      log.info("post", `Reasoning logged: ${reasoning.length} chars`, { model });
    }
  }

  // 2. Gate: combined length + self-feed-loop guard (MEM-6).
  const assistantText = assistantMessage || reasoning || "";
  const combinedLen = (userMessage?.length ?? 0) + assistantText.length;
  if (!shouldRunHippocampus(combinedLen, userMessage)) {
    log.debug(
      "post",
      `Skipping hippocampus: combinedLen=${combinedLen}, userMessage head="${(userMessage ?? "").slice(0, 60)}"`,
    );
    return;
  }

  // 3. Agentic extraction.
  const start = Date.now();
  try {
    const stats = await runHippocampus({
      memory,
      router,
      rag,
      executor,
      registry,
      userMessage,
      assistantText,
      reasoning,
      requestId,
      log,
      agentId: agentId ?? null,
    });
    log.info(
      "post",
      `Extraction done in ${Date.now() - start}ms: ${stats.factsWritten} facts, ${stats.tasksAdded} tasks, ${stats.searchCalls} searches, ${stats.steps} tool calls`,
      { meta: { ...stats } },
    );
  } catch (err) {
    log.error(
      "post",
      `Agentic extraction failed: ${err instanceof Error ? err.message : err}`,
    );
  }
}

export async function runPostFromStream(args: {
  memory: MemoryDB;
  router: ModelRouter;
  rag: RAGPipeline;
  executor: ToolExecutor;
  registry: ToolRegistry;
  stream: ReadableStream<Uint8Array>;
  userMessage: string;
  requestId: string;
  sessionId: string;
  model: string;
  log: RequestLogger;
  /** B-1: per-agent identity propagated to runPost. */
  agentId?: string | null;
}): Promise<void> {
  const {
    memory, router, rag, executor, registry,
    stream, userMessage, requestId, sessionId, model, log, agentId,
  } = args;

  const decoder = new TextDecoder();
  const contentChunks: string[] = [];
  const reasoningChunks: string[] = [];

  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      for (const line of text.split("\n")) {
        const delta = parseSSEChunk(line);
        if (!delta) continue;
        if (delta.content) contentChunks.push(delta.content);
        if (delta.reasoning_content) reasoningChunks.push(delta.reasoning_content);
      }
    }
  } finally {
    reader.releaseLock();
  }

  const fullResponse = contentChunks.join("");
  const fullReasoning = reasoningChunks.join("");

  log.info(
    "post",
    `Stream captured: ${fullResponse.length} chars content, ${fullReasoning.length} chars reasoning`,
    { model },
  );

  if (fullResponse || fullReasoning) {
    await runPost({
      memory,
      router,
      rag,
      executor,
      registry,
      userMessage,
      assistantMessage: fullResponse,
      requestId,
      sessionId,
      model,
      reasoning: fullReasoning || undefined,
      agentId: agentId ?? null,
    });
  }
}
