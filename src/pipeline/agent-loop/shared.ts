/**
 * Shared deps shape + small helpers used by both `run.ts` and `stream.ts`.
 * PR-8 (C-4): session-init and finalization helpers live here so the two
 * orchestrators do not drift.
 */
import { randomUUID } from "crypto";
import type { MemoryDB } from "../../db";
import type { ModelRouter } from "../../lib/model-router";
import type { RAGPipeline } from "../../rag";
import type { ToolExecutor, ToolRegistry } from "../../mcp";
import type { Tool, Message } from "../../providers/types";
import type { ArbitrationRoom } from "../arbitration-room";
import { logger } from "../../lib/logger";
import { runPost } from "../agent-pipeline/phases/post";
import type { DynamicToolRegistry } from "./dynamic-tools";
import type { CodeToolRegistry } from "./code-tools";
import type { ToolRunnerDeps } from "./tool-runner";
import type { StepDeps } from "./step";
import type { AgentLoopSession } from "./types";
import type { Priority } from "../../lib/model-map";
import { MAX_STEPS, AGENT_MODEL, type AgentLoopRequest } from "./types";
import { buildAgentSystemPrompt } from "./system-prompt";
import { persistToChat } from "./persist";

export interface AgentLoopDeps {
  memory: MemoryDB;
  router: ModelRouter;
  rag: RAGPipeline;
  tools: ToolExecutor;
  registry: ToolRegistry;
  dynamicTools: DynamicToolRegistry;
  codeTools: CodeToolRegistry;
  room: ArbitrationRoom | null;
  persistDynamicTools: () => void;
  getAllTools: () => Tool[];
}

export function toolRunnerDeps(
  deps: AgentLoopDeps,
  session: AgentLoopSession,
): ToolRunnerDeps {
  return {
    registry: deps.registry,
    tools: deps.tools,
    router: deps.router,
    room: deps.room,
    dynamicTools: deps.dynamicTools,
    persistDynamicTools: deps.persistDynamicTools,
    codeTools: deps.codeTools,
    session,
  };
}

export function stepDeps(
  deps: AgentLoopDeps,
  session: AgentLoopSession,
): StepDeps {
  return {
    router: deps.router,
    memory: deps.memory,
    tools: toolRunnerDeps(deps, session),
  };
}

export interface AgentLoopContext {
  requestId: string;
  sessionId: string;
  model: string;
  maxSteps: number;
  priority: Priority;
  log: ReturnType<typeof logger.forRequest>;
  session: AgentLoopSession;
  messages: Message[];
}

/**
 * Build the per-run context shared by both runLoop and runStreamLoop:
 * identities, logger, session quotas, and the initial [system, user] message
 * pair with the agent system prompt resolved.
 */
export async function initAgentLoopContext(
  deps: AgentLoopDeps,
  req: AgentLoopRequest,
): Promise<AgentLoopContext> {
  const requestId = randomUUID();
  const sessionId = req.sessionId || randomUUID();
  const model = req.model || AGENT_MODEL;
  const maxSteps = Math.min(req.maxSteps || MAX_STEPS, MAX_STEPS);
  const priority: Priority = req.priority || "critical";
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

  return { requestId, sessionId, model, maxSteps, priority, log, session, messages };
}

/**
 * End-of-run side effects shared by both orchestrators: write raw_log rows,
 * append to chats, and kick off post-processing (hippocampus). `summaryTag`
 * prefixes the assistant raw-log row (e.g. `[Autonomous: 5 steps] ...`).
 */
export function finalizeAgentRun(
  deps: AgentLoopDeps,
  ctx: AgentLoopContext,
  req: AgentLoopRequest,
  summary: string,
  summaryTag: string,
): void {
  deps.memory.appendLog(ctx.requestId, ctx.sessionId, ctx.model, "user", req.task);
  deps.memory.appendLog(
    ctx.requestId,
    ctx.sessionId,
    ctx.model,
    "assistant",
    `${summaryTag} ${summary}`,
  );
  persistToChat(
    deps.memory,
    ctx.sessionId,
    ctx.requestId,
    ctx.model,
    req.task,
    summary,
  );
  firePost(
    deps,
    {
      requestId: ctx.requestId,
      sessionId: ctx.sessionId,
      model: ctx.model,
      userMessage: req.task,
      assistantMessage: summary,
    },
    ctx.log,
  );
}

export function firePost(
  deps: AgentLoopDeps,
  params: {
    requestId: string;
    sessionId: string;
    model: string;
    userMessage: string;
    assistantMessage: string;
  },
  log: ReturnType<typeof logger.forRequest>,
): void {
  if (!params.assistantMessage) return;
  runPost({
    memory: deps.memory,
    router: deps.router,
    rag: deps.rag,
    executor: deps.tools,
    registry: deps.registry,
    userMessage: params.userMessage,
    assistantMessage: params.assistantMessage,
    requestId: params.requestId,
    sessionId: params.sessionId,
    model: params.model,
    options: { skipRawLog: true },
  }).catch((e) =>
    log.error(
      "post",
      `Agent post-processing failed: ${e instanceof Error ? e.message : e}`,
    ),
  );
}
