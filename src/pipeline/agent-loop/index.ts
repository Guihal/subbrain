/**
 * AgentLoop facade. Orchestration in `run.ts`/`stream.ts`, per-step logic in
 * `step.ts`, tool dispatch in `tool-dispatch.ts`, persistence in `persist.ts`.
 */
import type { MemoryDB } from "../../db";
import type { ModelRouter } from "../../lib/model-router";
import type { RAGPipeline } from "../../rag";
import type { ToolExecutor, ToolRegistry } from "../../mcp";
import type { Tool } from "../../providers/types";
import type { Metrics } from "../../lib/metrics";
import type { ArbitrationRoom } from "../arbitration-room";
import type { AgentLoopRequest, AgentLoopResult } from "./types";
import { DynamicToolRegistry } from "./dynamic-tools";
import { CodeToolRegistry } from "./code-tools";
import { loadPersistedDynamicTools, persistDynamicTools } from "./persist";
import { runLoop } from "./run";
import { runStreamLoop } from "./stream";
import type { AgentLoopDeps } from "./shared";

export { DynamicToolRegistry } from "./dynamic-tools";
export type { DynamicToolDef } from "./dynamic-tools";
export { CodeToolRegistry } from "./code-tools";
export type { AgentLoopRequest, AgentLoopStep, AgentLoopResult } from "./types";

export class AgentLoop {
  private room: ArbitrationRoom | null = null;
  private dynamicTools = new DynamicToolRegistry();
  private codeTools: CodeToolRegistry;

  constructor(
    private memory: MemoryDB,
    private router: ModelRouter,
    private rag: RAGPipeline,
    private tools: ToolExecutor,
    private registry: ToolRegistry,
  ) {
    this.codeTools = new CodeToolRegistry(memory.db);
    loadPersistedDynamicTools(memory, this.dynamicTools);
  }

  setMetrics(_m: Metrics): void {/* reserved */}
  setRoom(room: ArbitrationRoom): void { this.room = room; }

  run(req: AgentLoopRequest): Promise<AgentLoopResult> {
    return runLoop(this.deps(), req);
  }
  createStream(req: AgentLoopRequest): ReadableStream<Uint8Array> {
    return runStreamLoop(this.deps(), req);
  }

  private getAllTools(): Tool[] {
    return [
      ...this.registry.toOpenAITools(),
      ...this.dynamicTools.toToolDefs(),
      ...this.codeTools.toToolDefs(),
    ];
  }

  private deps(): AgentLoopDeps {
    return {
      memory: this.memory,
      router: this.router,
      rag: this.rag,
      tools: this.tools,
      registry: this.registry,
      dynamicTools: this.dynamicTools,
      codeTools: this.codeTools,
      room: this.room,
      persistDynamicTools: () => persistDynamicTools(this.memory, this.dynamicTools),
      getAllTools: () => this.getAllTools(),
    };
  }
}
