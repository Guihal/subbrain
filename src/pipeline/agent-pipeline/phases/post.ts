/** Post-processing phase: appendLog (Layer 4) + gated agentic extraction. */
import type { MemoryDB } from "@subbrain/core/db";
import { logger, type RequestLogger } from "@subbrain/core/lib/logger";
import { getTracer } from "@subbrain/core/lib/telemetry";
import { parseSSEChunk } from "@subbrain/providers/sse-parser";
import type { ModelRouter } from "../../../lib/model-router";
import type { ToolExecutor } from "../../../mcp";
import type { ToolRegistry } from "../../../mcp/registry";
import type { RAGPipeline } from "../../../rag";
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
    memory,
    router,
    rag,
    executor,
    registry,
    userMessage,
    assistantMessage,
    requestId,
    sessionId,
    model,
    usage,
    reasoning,
    options,
    agentId,
  } = args;

  const tracer = getTracer();
  const span = tracer.startSpan("subbrain.pipeline.post", {
    attributes: {
      "subbrain.phase": "post",
      "subbrain.role": model,
      "subbrain.request_id": requestId,
      "subbrain.tokens.prompt": usage?.prompt_tokens ?? 0,
      "subbrain.tokens.completion": usage?.completion_tokens ?? 0,
    },
  });

  try {
    const log = logger.forRequest(requestId, sessionId);
    log.info(
      "post",
      `Post-processing: user=${userMessage.length}ch assistant=${assistantMessage.length}ch`,
      { model },
    );

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
      if (reasoning?.length) {
        memory.appendLog(requestId, sessionId, model, "reasoning", reasoning);
        log.info("post", `Reasoning logged: ${reasoning.length} chars`, { model });
      }
    }
    const assistantText = assistantMessage || reasoning || "";
    const combinedLen = (userMessage?.length ?? 0) + assistantText.length;
    if (!shouldRunHippocampus(combinedLen, userMessage)) {
      log.debug("post", `Skip hippocampus: combinedLen=${combinedLen}`, { model });
      return;
    }
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
      log.error("post", `Agentic extraction failed: ${err instanceof Error ? err.message : err}`);
    }
  } finally {
    span.end();
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
    memory,
    router,
    rag,
    executor,
    registry,
    stream,
    userMessage,
    requestId,
    sessionId,
    model,
    log,
    agentId,
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
