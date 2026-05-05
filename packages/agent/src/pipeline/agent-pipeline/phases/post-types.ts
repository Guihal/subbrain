/** Post-phase type exports (split from post.ts to respect file-size cap). */
import type { MemoryDB } from "@subbrain/core/db";
import type { RequestLogger } from "@subbrain/core/lib/logger";
import type { ModelRouter } from "@subbrain/core/lib/model-router";
import type { ToolExecutor } from "../../../mcp";
import type { ToolRegistry } from "../../../mcp/registry";
import type { RAGPipeline } from "../../../rag";

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
  agentId?: string | null;
}

export interface RunPostFromStreamArgs {
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
  agentId?: string | null;
}
