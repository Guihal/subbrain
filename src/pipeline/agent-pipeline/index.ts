/**
 * AgentPipeline — Full 3-stage pipeline: pre → main → post.
 * Orchestrates memory context enrichment, model calls, and knowledge extraction.
 */
import { randomUUID } from "crypto";
import type { MemoryDB } from "../../db";
import type { ModelRouter } from "../../lib/model-router";
import type { Metrics } from "../../lib/metrics";
import type { RAGPipeline } from "../../rag";
import type { ChatResponse } from "../../providers/types";
import type { ArbitrationRoom } from "../arbitration-room";
import { logger } from "../../lib/logger";

import type { PipelineRequest, PipelineResult } from "./types";
import { preProcess } from "./pre-processing";
import { postProcess, postProcessFromStream } from "./post-processing";
import {
  extractLastUserMessage,
  isFirstMessage,
  buildSystemPrompt,
  injectSystemPrompt,
} from "./helpers";

// Re-exports
export type { PipelineRequest, PipelineResult } from "./types";

export class AgentPipeline {
  private metrics: Metrics | null = null;
  private room: ArbitrationRoom | null = null;

  constructor(
    private memory: MemoryDB,
    private router: ModelRouter,
    private rag: RAGPipeline,
  ) {}

  setMetrics(metrics: Metrics): void {
    this.metrics = metrics;
  }

  setArbitrationRoom(room: ArbitrationRoom): void {
    this.room = room;
  }

  async execute(req: PipelineRequest): Promise<PipelineResult> {
    const requestId = randomUUID();
    const sessionId = req.sessionId || randomUUID();
    const userMessage = extractLastUserMessage(req.messages);
    const log = logger.forRequest(requestId, sessionId);

    log.info(
      "pipeline",
      `▶ New request: model=${req.model} stream=${!!req.stream} msgs=${req.messages.length}`,
      {
        model: req.model,
        meta: { userMessage: userMessage.slice(0, 200) },
      },
    );

    const firstMsg = isFirstMessage(req.messages);
    log.debug("pipeline", `Decision: first=${firstMsg}`);

    // Streaming path
    if (req.stream) {
      const stream = this.createPipelineStream(
        req,
        requestId,
        sessionId,
        log,
        userMessage,
        firstMsg,
      );
      return { requestId, sessionId, stream };
    }

    // ─── Stage 1: Pre-processing ────────────────────────
    let enrichedSystemPrompt: string | undefined;

    if (firstMsg) {
      const preStart = Date.now();
      log.info("pre", "Starting pre-processing: RAG + focus fetch");
      const pre = await preProcess(
        this.memory,
        this.router,
        this.rag,
        userMessage,
        sessionId,
      );
      enrichedSystemPrompt = buildSystemPrompt(pre, req.model);
      const preDur = Date.now() - preStart;
      log.info(
        "pre",
        `Pre-processing complete: ${pre.ragResults.length} RAG results, summary ${pre.executiveSummary.length} chars`,
        {
          durationMs: preDur,
          meta: {
            ragCount: pre.ragResults.length,
            focusKeys: Object.keys(pre.focusEntries),
            summaryPreview: pre.executiveSummary.slice(0, 200),
          },
        },
      );
      this.metrics?.record({
        model: "flash",
        priority: "normal",
        stage: "pre",
        latencyMs: preDur,
        tokensIn: 0,
        tokensOut: 0,
        status: "ok",
      });
    } else {
      const focus = this.memory.getAllFocus();
      const shared = this.memory.getAllShared();
      log.debug(
        "pre",
        `Continuation: injecting identity + ${Object.keys(focus).length} focus keys + ${shared.length} shared facts`,
      );
      enrichedSystemPrompt = buildSystemPrompt(
        {
          executiveSummary: "",
          ragResults: [],
          focusEntries: focus,
          sharedMemory: shared,
          rawMemoryBlock: "",
        },
        req.model,
      );
    }

    // ─── Arbitration Room check ─────────────────────────
    if (!req.stream && this.room) {
      const roomConfig = this.room.classify(userMessage);
      if (roomConfig) {
        log.info(
          "main",
          `Arbitration Room activated: ${roomConfig.agents.join(",")}`,
          { model: "room" },
        );
        const mainStart = Date.now();
        const result = await this.room.run(
          userMessage,
          enrichedSystemPrompt || "",
          roomConfig,
        );
        log.info(
          "main",
          `Room synthesis complete: ${result.synthesis.length} chars`,
          { model: "teamlead", durationMs: Date.now() - mainStart },
        );
        this.metrics?.record({
          model: "room",
          priority: "critical",
          stage: "main",
          latencyMs: Date.now() - mainStart,
          tokensIn: 0,
          tokensOut: 0,
          status: "ok",
        });

        const response: ChatResponse = {
          id: `chatcmpl-${requestId}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "teamlead",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: result.synthesis },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };

        postProcess(
          this.memory,
          this.router,
          this.rag,
          userMessage,
          result.synthesis,
          requestId,
          sessionId,
          "teamlead",
        ).catch((err) => {
          log.error(
            "post",
            `Post-processing failed: ${err instanceof Error ? err.message : err}`,
          );
        });

        return { requestId, sessionId, response };
      }
    }

    // ─── Stage 2: Main execution ────────────────────────
    const messages = injectSystemPrompt(req.messages, enrichedSystemPrompt);
    const params = {
      messages,
      temperature: req.temperature,
      max_tokens: req.max_tokens,
      top_p: req.top_p,
      tools: req.tools,
      tool_choice: req.tool_choice,
    };

    log.info("main", `Non-stream call to ${req.model}`, { model: req.model });
    const mainStart = Date.now();
    const response = await this.router.chat(req.model, params);
    const mainDur = Date.now() - mainStart;
    const assistantMessage = response.choices[0]?.message?.content || "";
    const reasoningContent =
      (response.choices[0]?.message as any)?.reasoning_content || "";
    log.info(
      "main",
      `Response: ${assistantMessage.length} chars content, ${reasoningContent.length} chars reasoning`,
      {
        model: req.model,
        durationMs: mainDur,
        tokensIn: response.usage?.prompt_tokens || 0,
        tokensOut: response.usage?.completion_tokens || 0,
      },
    );
    this.metrics?.record({
      model: req.model,
      priority: "critical",
      stage: "main",
      latencyMs: mainDur,
      tokensIn: response.usage?.prompt_tokens || 0,
      tokensOut: response.usage?.completion_tokens || 0,
      status: "ok",
    });

    // Fire-and-forget post-processing
    postProcess(
      this.memory,
      this.router,
      this.rag,
      userMessage,
      assistantMessage,
      requestId,
      sessionId,
      req.model,
      response.usage,
      reasoningContent || undefined,
    ).catch((err) => {
      log.error(
        "post",
        `Post-processing failed: ${err instanceof Error ? err.message : err}`,
      );
    });

    log.info("pipeline", `◀ Request complete`, {
      model: req.model,
      durationMs: mainDur,
    });
    return { requestId, sessionId, response };
  }

  // ─── Streaming pipeline ───────────────────────────────

  private createPipelineStream(
    req: PipelineRequest,
    requestId: string,
    sessionId: string,
    log: import("../../lib/logger").RequestLogger,
    userMessage: string,
    firstMsg: boolean,
  ): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const self = this;

    const makeProgressChunk = (text: string): Uint8Array => {
      const chunk = {
        id: `chatcmpl-${requestId}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: req.model,
        choices: [
          { index: 0, delta: { reasoning_content: text }, finish_reason: null },
        ],
      };
      return encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`);
    };

    return new ReadableStream({
      async start(controller) {
        const keepalive = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": keepalive\n\n"));
          } catch {
            clearInterval(keepalive);
          }
        }, 8_000);

        try {
          const emit = (text: string) =>
            controller.enqueue(makeProgressChunk(text));
          let enrichedSystemPrompt: string | undefined;

          if (firstMsg) {
            const preStart = Date.now();
            log.info("pre", "Starting pre-processing: RAG + focus fetch");
            const pre = await preProcess(
              self.memory,
              self.router,
              self.rag,
              userMessage,
              sessionId,
              emit,
            );
            enrichedSystemPrompt = buildSystemPrompt(pre, req.model);
            const preDur = Date.now() - preStart;
            log.info(
              "pre",
              `Pre-processing complete: ${pre.ragResults.length} RAG results, summary ${pre.executiveSummary.length} chars`,
              {
                durationMs: preDur,
                meta: {
                  ragCount: pre.ragResults.length,
                  focusKeys: Object.keys(pre.focusEntries),
                  summaryPreview: pre.executiveSummary.slice(0, 200),
                },
              },
            );
            self.metrics?.record({
              model: "flash",
              priority: "normal",
              stage: "pre",
              latencyMs: preDur,
              tokensIn: 0,
              tokensOut: 0,
              status: "ok",
            });
          } else {
            emit("📋 Загрузка директив...\n");
            const focus = self.memory.getAllFocus();
            const shared = self.memory.getAllShared();
            log.debug(
              "pre",
              `Continuation: injecting identity + ${Object.keys(focus).length} focus keys + ${shared.length} shared facts`,
            );
            enrichedSystemPrompt = buildSystemPrompt(
              {
                executiveSummary: "",
                ragResults: [],
                focusEntries: focus,
                sharedMemory: shared,
                rawMemoryBlock: "",
              },
              req.model,
            );
          }

          emit(`💬 Отправка запроса к ${req.model}...\n`);

          const messages = injectSystemPrompt(
            req.messages,
            enrichedSystemPrompt,
          );
          const params = {
            messages,
            temperature: req.temperature,
            max_tokens: req.max_tokens,
            top_p: req.top_p,
            tools: req.tools,
            tool_choice: req.tool_choice,
          };

          log.info("main", `Streaming via ${req.model}`, { model: req.model });
          const modelStream = await self.router.chatStream(req.model, params);

          const capturedChunks: Uint8Array[] = [];
          const reader = modelStream.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
            capturedChunks.push(value);
          }

          // Fire-and-forget post-processing from captured chunks
          const capturedStream = new ReadableStream<Uint8Array>({
            start(ctrl) {
              for (const chunk of capturedChunks) ctrl.enqueue(chunk);
              ctrl.close();
            },
          });
          postProcessFromStream(
            self.memory,
            self.router,
            self.rag,
            capturedStream,
            userMessage,
            requestId,
            sessionId,
            req.model,
            log,
          ).catch((err) => {
            log.error(
              "post",
              `Stream post-processing failed: ${err instanceof Error ? err.message : err}`,
            );
          });

          clearInterval(keepalive);
          controller.close();
        } catch (err) {
          clearInterval(keepalive);
          log.error(
            "pipeline",
            `Pipeline stream error: ${err instanceof Error ? err.message : err}`,
          );
          const errMsg = err instanceof Error ? err.message : String(err);
          controller.enqueue(makeProgressChunk(`\n❌ Ошибка: ${errMsg}\n`));
          controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
          controller.close();
        }
      },
    });
  }
}
