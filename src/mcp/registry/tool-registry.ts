/**
 * Единый реестр тулов. Каждый тул описывается один раз и становится виден
 * через REST (/mcp/tools/*), MCP JSON-RPC и агент-луп — без switch-case.
 *
 * Добавление нового тула = одна registry.register(...). Забыл —
 * TypeScript ругается на неполные пути, а не ломается в рантайме.
 *
 * Scope split (A-9): PublicToolContext (REST/MCP) vs AgentToolContext (agent-loop).
 * ToolDef<Schema, Scope> infers handler's ctx type from declared scope; registry
 * exposes callAsPublic/callAsAgent — callAsPublic rejects agent-only tools at runtime.
 */
import { t, type TSchema, type Static } from "elysia";
import type { ToolExecutor } from "../executor";
import type { ToolResult } from "../types";
import type { ModelRouter } from "../../lib/model-router";
import type { ArbitrationRoom } from "../../pipeline/arbitration-room";
import type { logger } from "../../lib/logger";
import type { DynamicToolRegistry } from "../../pipeline/agent-loop/dynamic-tools";
import type { CodeToolRegistry } from "../../pipeline/agent-loop/code-tools";
import type { AgentLoopSession } from "../../pipeline/agent-loop/types";
// Re-export so existing imports from ./tool-registry keep working (A-8).
export type { AgentLoopSession } from "../../pipeline/agent-loop/types";

/** Тип лог-объекта, который агент-луп прокидывает в хендлеры. */
export type ToolLog = ReturnType<typeof logger.forRequest>;

/** Public context — REST + MCP JSON-RPC. Minimal. */
export interface PublicToolContext {
  executor: ToolExecutor;
}

/** Agent context — agent-loop only. All agent fields strictly present (null where legitimately nullable). */
export interface AgentToolContext extends PublicToolContext {
  router: ModelRouter;
  room: ArbitrationRoom | null; // nullable: single-specialist mode
  dynamicTools: DynamicToolRegistry;
  persistDynamicTools?: () => void;
  codeTools: CodeToolRegistry | null; // nullable: sandbox unavailable
  log: ToolLog;
  registry: ToolRegistry;
  session?: AgentLoopSession;
  taskBudget?: TaskMutationBudget;
}

/** Backward-compat alias for existing imports. */
export type ToolContext = PublicToolContext | AgentToolContext;

/** Hippocampus per-exchange guard. Mutable shared reference — every task_* mutation decrements `remaining`. */
export interface TaskMutationBudget {
  remaining: number;
}

/**
 * public     — REST + MCP JSON-RPC + агент-луп
 * agent-only — только агент-луп (think, done, consult_*, create_tool, ...)
 */
export type ToolScope = "public" | "agent-only";

/** Map scope → ctx type. */
export type ToolContextFor<Scope extends ToolScope> = Scope extends "agent-only"
  ? AgentToolContext
  : PublicToolContext;

export interface ToolDef<
  Schema extends TSchema = TSchema,
  Scope extends ToolScope = ToolScope,
> {
  name: string;
  description: string;
  scope: Scope;
  /** TypeBox схема. Работает и как JSON Schema для OpenAI, и как валидатор. */
  input: Schema;
  /**
   * Handler gets optional `signal` — fired when the tool-runner's timeout elapses
   * or when the caller aborts externally. Short-running handlers (memory_*, embed_*,
   * task_*) may ignore it; long-running ones (web_*, consult_*, critic_*) must
   * forward it to downstream fetch / router.chat / PlaywrightClient so stragglers
   * don't keep eating RPM after the result is discarded (CANCEL-1 / PR 20).
   */
  handler: (
    args: Static<Schema>,
    ctx: ToolContextFor<Scope>,
    signal?: AbortSignal,
  ) => ToolResult | Promise<ToolResult>;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDef>();

  register<Schema extends TSchema, Scope extends ToolScope>(
    def: ToolDef<Schema, Scope>,
  ): void {
    if (this.tools.has(def.name)) {
      throw new Error(`Duplicate tool: ${def.name}`);
    }
    this.tools.set(def.name, def as unknown as ToolDef);
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(scope?: ToolScope): ToolDef[] {
    const all = Array.from(this.tools.values());
    return scope ? all.filter((tool) => tool.scope === scope) : all;
  }

  /** Короткий список для REST /mcp/tools/list (только публичные). */
  listPublic(): { name: string; description: string }[] {
    return this.list("public").map((tool) => ({
      name: tool.name,
      description: tool.description,
    }));
  }

  /** Полный список с JSON-схемами в MCP-формате (для mcp-protocol.ts). */
  listForMcp(): {
    name: string;
    description: string;
    inputSchema: unknown;
  }[] {
    return this.list("public").map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.input,
    }));
  }

  /** OpenAI function-calling schema для агент-лупа. */
  toOpenAITools(scope?: ToolScope) {
    return this.list(scope).map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        // TypeBox-схема = JSON Schema; symbols отпадают при сериализации.
        parameters: tool.input as unknown as Record<string, unknown>,
      },
    }));
  }

  /** Public caller (REST, MCP JSON-RPC). Agent-only tools rejected at runtime. */
  async callAsPublic(
    name: string,
    args: unknown,
    ctx: PublicToolContext,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) return { success: false, error: `Unknown tool: ${name}` };
    if (tool.scope === "agent-only") {
      return {
        success: false,
        error: `Tool "${name}" requires agent context (scope=agent-only)`,
      };
    }
    try {
      return await tool.handler(args as Static<typeof tool.input>, ctx, signal);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  }

  /** Agent caller (agent-loop). No scope check — agent context is superset of public. */
  async callAsAgent(
    name: string,
    args: unknown,
    ctx: AgentToolContext,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) return { success: false, error: `Unknown tool: ${name}` };
    try {
      return await tool.handler(args as Static<typeof tool.input>, ctx, signal);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  }
}

// Чтобы дочерние файлы могли использовать t без отдельного импорта.
export { t };
