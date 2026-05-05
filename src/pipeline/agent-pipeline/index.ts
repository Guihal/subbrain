/** AgentPipeline — orchestrates pre → main → post (or arbitration room). */
import { randomUUID } from "node:crypto";
import type { MemoryDB } from "../../db";
import { logger } from "../../lib/logger";
import type { Metrics } from "../../lib/metrics";
import type { ModelRouter } from "../../lib/model-router";
import type { ToolExecutor } from "../../mcp";
import type { ToolRegistry } from "../../mcp/registry";
import type { RAGPipeline } from "../../rag";
import type { ArbitrationRoom } from "../arbitration";
import { extractLastUserMessage, isFirstMessage } from "./helpers";
import { runMain } from "./phases/main";
import { type RunPostArgs, runPost } from "./phases/post";
import { runPre } from "./phases/pre";
import { runRoom } from "./phases/room";
import { buildPipelineStream } from "./phases/stream";
import type { PipelineRequest, PipelineResult } from "./types";

export type { PipelineRequest, PipelineResult } from "./types";

export class AgentPipeline {
  private metrics: Metrics | null = null;
  private room: ArbitrationRoom | null = null;

  constructor(
    private memory: MemoryDB,
    private router: ModelRouter,
    private rag: RAGPipeline,
    private executor: ToolExecutor,
    private registry: ToolRegistry,
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
    const firstMsg = isFirstMessage(req.messages);
    const deps = {
      memory: this.memory,
      router: this.router,
      rag: this.rag,
      executor: this.executor,
      registry: this.registry,
    };

    log.info(
      "pipeline",
      `▶ model=${req.model} stream=${!!req.stream} msgs=${req.messages.length} first=${firstMsg}`,
      { model: req.model, meta: { userMessage: userMessage.slice(0, 200) } },
    );

    if (req.stream) {
      const stream = buildPipelineStream({
        req,
        requestId,
        sessionId,
        log,
        userMessage,
        firstMessage: firstMsg,
        deps: {
          memory: this.memory,
          router: this.router,
          rag: this.rag,
          executor: this.executor,
          registry: this.registry,
          metrics: this.metrics,
        },
      });
      return { requestId, sessionId, stream };
    }

    const agentId: string | null = req.agentId ?? null;

    const preStart = Date.now();
    const pre = await runPre({
      ...deps,
      model: req.model,
      userMessage,
      firstMessage: firstMsg,
      agentId,
    });
    if (firstMsg) {
      this.metrics?.record({
        model: "coder",
        priority: "normal",
        stage: "pre",
        latencyMs: Date.now() - preStart,
        tokensIn: 0,
        tokensOut: 0,
        status: "ok",
      });
    }

    const fire = (assistantMessage: string, model: string, extras: Partial<RunPostArgs> = {}) =>
      runPost({
        ...deps,
        userMessage,
        assistantMessage,
        requestId,
        sessionId,
        model,
        agentId,
        ...extras,
      }).catch((err) =>
        log.error("post", `Post failed: ${err instanceof Error ? err.message : err}`),
      );

    const roomConfig = this.room?.classify(userMessage);
    if (this.room && roomConfig) {
      const roomRes = await runRoom({
        room: this.room,
        userMessage,
        systemPrompt: pre.enrichedSystemPrompt,
        roomConfig,
        requestId,
        metrics: this.metrics,
        log,
      });
      await fire(roomRes.synthesis, "teamlead");
      return { requestId, sessionId, response: roomRes.response };
    }

    const main = await runMain({
      req,
      router: this.router,
      enrichedSystemPrompt: pre.enrichedSystemPrompt,
      metrics: this.metrics,
      log,
    });
    const msg = main.response.choices[0]?.message;
    await fire(msg?.content || "", req.model, {
      reasoning: msg?.reasoning_content || undefined,
      usage: main.response.usage,
    });
    log.info("pipeline", `◀ done`, { model: req.model, durationMs: main.durationMs });
    return { requestId, sessionId, response: main.response };
  }
}
