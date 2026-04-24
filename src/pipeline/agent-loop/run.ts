/**
 * runLoop — non-stream agent loop. Shares session init + finalization with
 * `runStreamLoop` via `initAgentLoopContext` / `finalizeAgentRun`; owns only
 * the step-collecting iteration and result shape.
 */
import type {
  AgentLoopRequest,
  AgentLoopStep,
  AgentLoopResult,
} from "./types";
import { executeStep } from "./step";
import {
  stepDeps,
  initAgentLoopContext,
  finalizeAgentRun,
  type AgentLoopDeps,
} from "./shared";

export { runStreamLoop } from "./stream";
export type { AgentLoopDeps } from "./shared";

export async function runLoop(
  deps: AgentLoopDeps,
  req: AgentLoopRequest,
): Promise<AgentLoopResult> {
  const ctx = await initAgentLoopContext(deps, req);
  const {
    requestId,
    sessionId,
    model,
    maxSteps,
    priority,
    agentMode,
    log,
    session,
    messages,
  } = ctx;

  log.info(
    "agent-loop",
    `▶ Starting autonomous loop: "${req.task.slice(0, 100)}"`,
    { model, meta: { maxSteps, priority, agentMode } },
  );

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
        getAllTools: () => deps.getAllTools(agentMode),
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

  finalizeAgentRun(
    deps,
    ctx,
    req,
    finalAnswer,
    `[Autonomous loop: ${steps.length} steps, reason: ${stoppedReason}]\n\n`,
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
