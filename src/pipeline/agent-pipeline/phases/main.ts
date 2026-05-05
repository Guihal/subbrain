/**
 * Main phase: non-streaming model call with metrics + post-processing fire-and-forget.
 */

import type { RequestLogger } from "../../../lib/logger";
import type { Metrics } from "../../../lib/metrics";
import type { ModelRouter } from "../../../lib/model-router";
import type { ChatResponse } from "../../../providers/types";
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
}): Promise<MainResult> {
  const { req, router, enrichedSystemPrompt, metrics, log } = args;

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

  log.info(
    "main",
    `Response: ${assistantMessage.length} chars content, ${reasoningContent.length} chars reasoning`,
    {
      model: req.model,
      durationMs,
      tokensIn: response.usage?.prompt_tokens || 0,
      tokensOut: response.usage?.completion_tokens || 0,
    },
  );
  metrics?.record({
    model: req.model,
    priority: "critical",
    stage: "main",
    latencyMs: durationMs,
    tokensIn: response.usage?.prompt_tokens || 0,
    tokensOut: response.usage?.completion_tokens || 0,
    status: "ok",
  });

  return { response, durationMs };
}
