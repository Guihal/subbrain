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

/**
 * Public context — REST + MCP JSON-RPC. Minimal.
 *
 * B-1: `agentId` lives on the public base so handlers like `memory_search`
 * (scope:"public", but reachable from the agent-loop via `callAsAgent`) can
 * scope context-layer reads to the calling agent. REST/MCP transports default
 * it to `null` (admin scope); the agent-loop populates it from
 * `AgentToolContext.agentId`.
 */
export interface PublicToolContext {
  executor: ToolExecutor;
  agentId: string | null;
  /**
   * Execution mode (SCHED-1). Used by handlers that gate on
   * scheduled-vs-interactive (e.g. tg_send_message focus-block in F-4).
   * Undefined / missing → treated as interactive (backward-compat for
   * REST/MCP callers that have no scheduler context).
   */
  agentMode?: AgentMode;
}

/**
 * Agent context — agent-loop only.
 *
 * H-4: capability fields are nullable/optional. Handlers null-check before
 * use (already the pattern for `room`, `codeTools`, `session`, `taskBudget`).
 * The previous design forced sub-callers (post-hippocampus, integration tests)
 * to lie via `as unknown as AgentToolContext` because they did not own a
 * router or DynamicToolRegistry. With nullable fields the cast goes away.
 *
 * Required: `executor`, `agentId`, `log`, `registry` — every handler that
 * runs inside the agent loop has these. Optional: `router`, `room`,
 * `dynamicTools`, `codeTools`, `persistDynamicTools`, `session`, `taskBudget`.
 */
export interface AgentToolContext extends PublicToolContext {
  router: ModelRouter | null;
  room: ArbitrationRoom | null; // nullable: single-specialist mode
  dynamicTools: DynamicToolRegistry | null;
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

/**
 * Agent execution mode surfaced to the registry (SCHED-1).
 * Mirrors `AgentMode` in `pipeline/agent-loop/types.ts`; kept local to avoid a
 * cross-layer import from registry → pipeline.
 */
export type AgentMode = "scheduled" | "interactive";

/**
 * Tools hidden from the model when running in `scheduled` mode. Existing
 * `code_*` tools + dynamic tools stay callable — only creation/editing
 * primitives are removed (no fresh executable code without a human).
 */
export const SCHEDULED_HIDDEN_TOOLS: ReadonlySet<string> = new Set([
  "create_tool",
  "create_code_tool",
  "edit_code_tool",
]);

function scheduledGuardDisabled(): boolean {
  return process.env.SCHEDULED_ALLOW_CODE_TOOL_CREATE === "1";
}

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

  /**
   * Agent-loop tool listing filtered by execution mode (SCHED-1).
   *
   * - `interactive` → all tools (same as `list()`).
   * - `scheduled`   → drop `SCHEDULED_HIDDEN_TOOLS` (create_tool /
   *   create_code_tool / edit_code_tool) so the model cannot spawn fresh
   *   executable code without a human approver. `code_*` + dynamic tools
   *   remain callable — only the creation/edit primitives disappear.
   *
   * `SCHEDULED_ALLOW_CODE_TOOL_CREATE=1` opts in to the interactive set for
   * manual operator runs on a scheduler endpoint.
   */
  listForAgent(mode: AgentMode): ToolDef[] {
    const all = Array.from(this.tools.values());
    if (mode === "interactive" || scheduledGuardDisabled()) return all;
    return all.filter((tool) => !SCHEDULED_HIDDEN_TOOLS.has(tool.name));
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

  /**
   * Same shape as `toOpenAITools()` but filtered by `AgentMode` via
   * `listForAgent(mode)` — used by the agent-loop to expose a mode-aware tool
   * list to the specialist model.
   */
  toOpenAIToolsForAgent(mode: AgentMode) {
    return this.listForAgent(mode).map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
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
