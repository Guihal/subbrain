/**
 * Shared deps shape + small helpers used by both `run.ts` and `stream.ts`.
 */
import type { MemoryDB } from "../../db";
import type { ModelRouter } from "../../lib/model-router";
import type { RAGPipeline } from "../../rag";
import type { ToolExecutor, ToolRegistry } from "../../mcp";
import type { Tool } from "../../providers/types";
import type { ArbitrationRoom } from "../arbitration-room";
import type { logger } from "../../lib/logger";
import { runPost } from "../agent-pipeline/phases/post";
import type { DynamicToolRegistry } from "./dynamic-tools";
import type { CodeToolRegistry } from "./code-tools";
import type { ToolRunnerDeps } from "./tool-runner";
import type { StepDeps } from "./step";

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

export function toolRunnerDeps(deps: AgentLoopDeps): ToolRunnerDeps {
  return {
    registry: deps.registry,
    tools: deps.tools,
    router: deps.router,
    room: deps.room,
    dynamicTools: deps.dynamicTools,
    persistDynamicTools: deps.persistDynamicTools,
    codeTools: deps.codeTools,
  };
}

export function stepDeps(deps: AgentLoopDeps): StepDeps {
  return {
    router: deps.router,
    memory: deps.memory,
    tools: toolRunnerDeps(deps),
  };
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
