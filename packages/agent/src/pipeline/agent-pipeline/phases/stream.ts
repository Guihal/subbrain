/**
 * Streaming pipeline path: pre → SSE proxy → captured tail used for post-processing.
 */
import type { MemoryDB } from "@subbrain/core/db";
import type { RequestLogger } from "@subbrain/core/lib/logger";
import type { Metrics } from "@subbrain/core/lib/metrics";
import { getTracer } from "@subbrain/core/lib/telemetry";
import type { ModelRouter } from "@subbrain/core/lib/model-router";
import type { ToolExecutor } from "../../../mcp";
import type { ToolRegistry } from "../../../mcp/registry";
import type { RAGPipeline } from "../../../rag";
import { injectSystemPrompt } from "../helpers";
import type { PipelineRequest } from "../types";
import { runPostFromStream } from "./post";
import { runPre } from "./pre";
import type { HooksDispatcher } from "../../../hooks";

const SSE_KEEPALIVE_MS = 8_000;

export interface StreamDeps {
  memory: MemoryDB;
  router: ModelRouter;
  rag: RAGPipeline;
  executor: ToolExecutor;
  registry: ToolRegistry;
  metrics: Metrics | null;
}

export function buildPipelineStream(args: {
  req: PipelineRequest;
  requestId: string;
  sessionId: string;
  log: RequestLogger;
  userMessage: string;
  firstMessage: boolean;
  deps: StreamDeps;
  hooks?: HooksDispatcher;
}): ReadableStream<Uint8Array> {
  const { req, requestId, sessionId, log, userMessage, firstMessage, deps } = args;
  const encoder = new TextEncoder();

  const makeProgressChunk = (text: string): Uint8Array => {
    const chunk = {
      id: `chatcmpl-${requestId}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: req.model,
      choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }],
    };
    return encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`);
  };

  return new ReadableStream({
    async start(controller) {
      const tracer = getTracer();
      const span = tracer.startSpan("subbrain.pipeline.stream", {
        attributes: {
          "subbrain.phase": "stream",
          "subbrain.role": req.model,
          "subbrain.request_id": requestId,
          "subbrain.tokens.prompt": 0,
          "subbrain.tokens.completion": 0,
        },
      });

      const keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          clearInterval(keepalive);
        }
      }, SSE_KEEPALIVE_MS);

      try {
        const emit = (text: string) => controller.enqueue(makeProgressChunk(text));

        const agentId: string | null = req.agentId ?? null;
        const preStart = Date.now();
        log.info("pre", "Starting pre-processing");
        const pre = await runPre({
          memory: deps.memory,
          router: deps.router,
          rag: deps.rag,
          model: req.model,
          userMessage,
          firstMessage,
          onProgress: firstMessage ? emit : undefined,
          agentId,
          requestId,
          hooks: args.hooks,
        });
        const preDur = Date.now() - preStart;
        log.info(
          "pre",
          `Pre-processing complete: ${pre.stats.ragCount} RAG, ${pre.stats.summaryLen} chars`,
          {
            durationMs: preDur,
            meta: {
              ragCount: pre.stats.ragCount,
              focusKeys: pre.stats.focusKeys,
            },
          },
        );
        deps.metrics?.record({
          model: "coder",
          priority: "normal",
          stage: "pre",
          latencyMs: preDur,
          tokensIn: 0,
          tokensOut: 0,
          status: "ok",
        });

        emit(`💬 Отправка запроса к ${req.model}...\n`);
        const messages = injectSystemPrompt(req.messages, pre.enrichedSystemPrompt);
        const params = {
          model: req.model,
          messages,
          temperature: req.temperature,
          max_tokens: req.max_tokens,
          top_p: req.top_p,
          tools: req.tools ?? [],
          tool_choice: req.tool_choice,
        };

        if (args.hooks) { const transformed = await args.hooks.runChatParams(params); if (transformed) Object.assign(params, transformed); }
        log.info("main", `Streaming via ${req.model}`, { model: req.model });
        const modelStream = await deps.router.chatStream(req.model, params);

        const captured: Uint8Array[] = [];
        const reader = modelStream.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
          captured.push(value);
        }

        const capturedStream = new ReadableStream<Uint8Array>({
          start(ctrl) {
            for (const chunk of captured) ctrl.enqueue(chunk);
            ctrl.close();
          },
        });
        runPostFromStream({
          memory: deps.memory,
          router: deps.router,
          rag: deps.rag,
          executor: deps.executor,
          registry: deps.registry,
          stream: capturedStream,
          userMessage,
          requestId,
          sessionId,
          model: req.model,
          log,
          agentId,
        }).catch((err) => {
          log.error(
            "post",
            `Stream post-processing failed: ${err instanceof Error ? err.message : err}`,
          );
        });

        clearInterval(keepalive);
        controller.close();
      } catch (err) {
        clearInterval(keepalive);
        log.error("pipeline", `Pipeline stream error: ${err instanceof Error ? err.message : err}`);
        const errMsg = err instanceof Error ? err.message : String(err);
        controller.enqueue(makeProgressChunk(`\n❌ Ошибка: ${errMsg}\n`));
        controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
        controller.close();
      } finally {
        span.end();
      }
    },
  });
}
