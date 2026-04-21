/**
 * runLoop — non-stream agent loop. Owns the outer step iteration, system
 * prompt build, chat row persistence, and fire-and-forget post-processing.
 */
import { randomUUID } from "crypto";
import type { Message } from "../../providers/types";
import { logger } from "../../lib/logger";
import {
  MAX_STEPS,
  AGENT_MODEL,
  type AgentLoopRequest,
  type AgentLoopStep,
  type AgentLoopResult,
} from "./types";
import { buildAgentSystemPrompt } from "./system-prompt";
import { executeStep } from "./step";
import { persistToChat } from "./persist";
import { firePost, stepDeps, type AgentLoopDeps } from "./shared";
import type { AgentLoopSession } from "../../mcp/registry/tool-registry";

export { runStreamLoop } from "./stream";
export type { AgentLoopDeps } from "./shared";

export async function runLoop(
  deps: AgentLoopDeps,
  req: AgentLoopRequest,
): Promise<AgentLoopResult> {
  const requestId = randomUUID();
  const sessionId = req.sessionId || randomUUID();
  const model = req.model || AGENT_MODEL;
  const maxSteps = Math.min(req.maxSteps || MAX_STEPS, MAX_STEPS);
  const priority = req.priority || "critical";
  const log = logger.forRequest(requestId, sessionId);

  const session: AgentLoopSession = {
    consultSpecialistsCount: 0,
    consultSpecialistsMax: Math.max(
      1,
      Number(process.env.AGENT_CONSULT_SPECIALISTS_MAX) || 3,
    ),
    consultChaosCount: 0,
    consultChaosMax: Math.max(
      1,
      Number(process.env.AGENT_CONSULT_CHAOS_MAX) || 5,
    ),
  };

  log.info(
    "agent-loop",
    `▶ Starting autonomous loop: "${req.task.slice(0, 100)}"`,
    { model, meta: { maxSteps, priority } },
  );

  const systemPrompt = await buildAgentSystemPrompt(
    deps.memory,
    deps.rag,
    req.task,
    model,
    deps.router,
    req.schedule,
  );
  const messages: Message[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: req.task },
  ];

  const steps: AgentLoopStep[] = [];
  let finalAnswer = "";
  let lastContent = "";
  let stoppedReason: AgentLoopResult["stoppedReason"] = "max_steps";

  for (let step = 1; step <= maxSteps; step++) {
    log.info("agent-loop", `Step ${step}/${maxSteps}`, { model });

    const result = await executeStep(
      stepDeps(deps, session),
      {
        step,
        maxSteps,
        model,
        priority,
        messages,
        getAllTools: deps.getAllTools,
      },
      log,
      {
        onAssistantWithTools: (msg) =>
          steps.push({
            step,
            role: "assistant",
            content: msg.content ?? null,
            toolCalls: msg.tool_calls,
          }),
        onToolCallResult: (tc, toolResult) =>
          steps.push({
            step,
            role: "tool",
            content: toolResult,
            toolName: tc.function.name,
            toolResult,
          }),
        onAssistantContent: (content) => {
          lastContent = content;
          steps.push({ step, role: "assistant", content });
        },
      },
    );

    if (result.kind === "done") {
      finalAnswer = result.summary;
      stoppedReason = "done";
      break;
    }
    if (result.kind === "error") {
      log.error("agent-loop", `Step ${step}: ${result.error}`);
      stoppedReason = "error";
      finalAnswer = `Error: ${result.error}`;
      break;
    }
    if (result.kind === "empty") {
      log.warn("agent-loop", `Step ${step}: empty response, nudging`);
    }
  }

  if (stoppedReason === "max_steps" && !finalAnswer) {
    finalAnswer = lastContent || "Agent reached max steps without calling done";
  }

  log.info(
    "agent-loop",
    `◀ Loop finished: ${steps.length} steps, reason=${stoppedReason}`,
    { model, meta: { steps: steps.length, reason: stoppedReason } },
  );

  deps.memory.appendLog(requestId, sessionId, model, "user", req.task);
  deps.memory.appendLog(
    requestId,
    sessionId,
    model,
    "assistant",
    `[Autonomous loop: ${steps.length} steps, reason: ${stoppedReason}]\n\n${finalAnswer}`,
  );
  persistToChat(deps.memory, sessionId, requestId, model, req.task, finalAnswer);
  firePost(
    deps,
    {
      requestId,
      sessionId,
      model,
      userMessage: req.task,
      assistantMessage: finalAnswer,
    },
    log,
  );

  return {
    requestId,
    sessionId,
    steps,
    finalAnswer,
    totalSteps: steps.length,
    stoppedReason,
  };
}
