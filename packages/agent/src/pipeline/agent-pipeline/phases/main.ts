/**
 * Main phase: non-streaming model call with metrics + post-processing fire-and-forget.
 */

import type { RequestLogger } from "@subbrain/core/lib/logger";
import type { Metrics } from "@subbrain/core/lib/metrics";
import { getTracer } from "@subbrain/core/lib/telemetry";
import type { ChatResponse } from "@subbrain/providers/types";
import type { ModelRouter } from "@subbrain/core/lib/model-router";
import { injectSystemPrompt } from "../helpers";
import type { PipelineRequest } from "../types";

export interface MainResult {
  response: ChatResponse;
  durationMs: number;
}

export async function runMain(args: {
  req: PipelineRequest;
  router: ModelRouter;
  enrichedSystemPrompt?: string;
  metrics: Metrics | null;
  log: RequestLogger;
  requestId?: string;
}): Promise<MainResult> {
  const { req, router, enrichedSystemPrompt, metrics, log, requestId = "" } = args;

  const tracer = getTracer();
  const span = tracer.startSpan("subbrain.pipeline.main", {
    attributes: {
      "subbrain.phase": "main",
      "subbrain.role": req.model,
      "subbrain.request_id": requestId,
      "subbrain.tokens.prompt": 0,
      "subbrain.tokens.completion": 0,
    },
  });

  try {
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
    const start = Date.now();
    const response = await router.chat(req.model, params);
    const durationMs = Date.now() - start;

    const assistantMessage = response.choices[0]?.message?.content || "";
    const reasoningContent = response.choices[0]?.message?.reasoning_content || "";

    const promptTokens = response.usage?.prompt_tokens || 0;
    const completionTokens = response.usage?.completion_tokens || 0;
    span.setAttribute("subbrain.tokens.prompt", promptTokens);
    span.setAttribute("subbrain.tokens.completion", completionTokens);

    log.info(
      "main",
      `Response: ${assistantMessage.length} chars content, ${reasoningContent.length} chars reasoning`,
      {
        model: req.model,
        durationMs,
        tokensIn: promptTokens,
        tokensOut: completionTokens,
      },
    );
    metrics?.record({
      model: req.model,
      priority: "critical",
      stage: "main",
      latencyMs: durationMs,
      tokensIn: promptTokens,
      tokensOut: completionTokens,
      status: "ok",
    });

    return { response, durationMs };
  } finally {
    span.end();
  }
}
