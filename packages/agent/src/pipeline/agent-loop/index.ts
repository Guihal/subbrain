/**
 * AgentLoop facade. Orchestration in `run.ts`/`stream.ts`, per-step logic in
 * `step.ts`, tool dispatch in `tool-dispatch.ts`, persistence in `persist.ts`.
 */
import type { MemoryDB } from "@subbrain/core/db";
import type { Metrics } from "@subbrain/core/lib/metrics";
import { CodeToolsRepository } from "@subbrain/core/repositories/code-tools.repo";
import type { Tool } from "@subbrain/providers/types";
import type { ModelRouter } from "@subbrain/core/lib/model-router";
import type { ToolExecutor, ToolRegistry } from "../../mcp";
import type { RAGPipeline } from "../../rag";
import type { ArbitrationRoom } from "../arbitration";
import type { HooksDispatcher } from "../../hooks";
import { CodeToolRegistry } from "./code-tools";
import { DynamicToolRegistry } from "./dynamic-tools";
import { loadPersistedDynamicTools, persistDynamicTools } from "./persist";
import { runLoop } from "./run";
import type { AgentLoopDeps } from "./shared";
import { runStreamLoop } from "./stream";
import type { AgentLoopRequest, AgentLoopResult, AgentMode } from "./types";

export { CodeToolRegistry } from "./code-tools";
export type { DynamicToolDef } from "./dynamic-tools";
export { DynamicToolRegistry } from "./dynamic-tools";
export type {
  AgentLoopRequest,
  AgentLoopResult,
  AgentLoopStep,
  AgentMode,
} from "./types";

export class AgentLoop {
  private room: ArbitrationRoom | null = null;
  private hooks: HooksDispatcher | null = null;
  private dynamicTools = new DynamicToolRegistry();
  private codeTools: CodeToolRegistry;

  constructor(
    private memory: MemoryDB,
    private router: ModelRouter,
    private rag: RAGPipeline,
    private tools: ToolExecutor,
    private registry: ToolRegistry,
  ) {
    this.codeTools = new CodeToolRegistry(new CodeToolsRepository(memory.db));
    loadPersistedDynamicTools(memory, this.dynamicTools);
  }

  setMetrics(_m: Metrics): void {
    /* reserved */
  }
  setRoom(room: ArbitrationRoom): void {
    this.room = room;
  }
  setHooks(hooks: HooksDispatcher): void {
    this.hooks = hooks;
  }

  run(req: AgentLoopRequest): Promise<AgentLoopResult> {
    return runLoop(this.deps(), req);
  }
  createStream(req: AgentLoopRequest): ReadableStream<Uint8Array> {
    return runStreamLoop(this.deps(), req);
  }

  private getAllTools(mode: AgentMode): Tool[] {
    // SCHED-1: `registry.toOpenAIToolsForAgent(mode)` drops
    // create_tool / create_code_tool / edit_code_tool in `scheduled` mode.
    // Dynamic + code_* tools stay callable — only creation primitives go.
    return [
      ...this.registry.toOpenAIToolsForAgent(mode),
      ...this.dynamicTools.toToolDefs(),
      ...this.codeTools.toToolDefs(mode),
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
      hooks: this.hooks ?? undefined,
      persistDynamicTools: () => persistDynamicTools(this.memory, this.dynamicTools),
      getAllTools: (mode) => this.getAllTools(mode),
    };
  }
}
