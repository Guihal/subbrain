/**
 * Единый реестр тулов. Каждый тул описывается один раз и становится виден
 * через REST (/mcp/tools/*), MCP JSON-RPC и агент-луп — без switch-case.
 *
 * Добавление нового тула = одна registry.register(...). Забыл —
 * TypeScript ругается на неполные пути, а не ломается в рантайме.
 */
import { t, type TSchema, type Static } from "elysia";
import type { ToolExecutor } from "../executor";
import type { ToolResult } from "../types";
import type { ModelRouter } from "../../lib/model-router";
import type { ArbitrationRoom } from "../../pipeline/arbitration-room";
import type { logger } from "../../lib/logger";
import type {
  DynamicToolRegistry,
} from "../../pipeline/agent-loop/dynamic-tools";
import type { CodeToolRegistry } from "../../pipeline/agent-loop/code-tools";

/** Тип лог-объекта, который агент-луп прокидывает в хендлеры. */
export type ToolLog = ReturnType<typeof logger.forRequest>;

/**
 * Контекст, доступный каждому хендлеру.
 *
 * Публичные вызовы (REST, MCP JSON-RPC) заполняют только `executor`.
 * Агент-луп дополнительно передаёт `router`, `room`, `dynamicTools`,
 * `codeTools`, `log`, `registry`. Хендлеры agent-only-тулов обязаны
 * проверять, что нужные поля не пустые.
 */
export interface ToolContext {
  executor: ToolExecutor;
  router?: ModelRouter;
  room?: ArbitrationRoom | null;
  dynamicTools?: DynamicToolRegistry;
  persistDynamicTools?: () => void;
  codeTools?: CodeToolRegistry | null;
  log?: ToolLog;
  /** Ссылка на реестр (нужна list_tools). Заполняет тот, кто вызывает. */
  registry?: ToolRegistry;
  /** Session quotas. Populated by agent-loop only. REST/MCP callers → undefined. */
  session?: AgentLoopSession;
  /**
   * Per-exchange task mutation budget. Populated by hippocampus only; every
   * `task_*` mutating handler (add/update/start/done/cancel) decrements by 1
   * and returns `rate_limit` when remaining ≤ 0. `undefined` → unlimited
   * (normal agent-loop + REST/MCP paths bypass the guard).
   * Attempt-based: failed upstream still consumes the slot (retry-amplified
   * spam protection), symmetric with AgentLoopSession.
   */
  taskBudget?: TaskMutationBudget;
}

/**
 * Session-scoped quotas for cost-heavy tools. Agent-loop creates a fresh
 * instance per run (run.ts / stream.ts); handlers check presence and
 * increment before the costly call (attempt-based semantics — a failed
 * upstream still consumes the slot, to avoid retry-amplified load).
 */
export interface AgentLoopSession {
  consultSpecialistsCount: number;
  consultSpecialistsMax: number;
  consultChaosCount: number;
  consultChaosMax: number;
}

/** Hippocampus per-exchange guard. Mutable shared reference — every task_* mutation decrements `remaining`. */
export interface TaskMutationBudget {
  remaining: number;
}

/**
 * public     — REST + MCP JSON-RPC + агент-луп
 * agent-only — только агент-луп (think, done, consult_*, create_tool, ...)
 */
export type ToolScope = "public" | "agent-only";

export interface ToolDef<S extends TSchema = TSchema> {
  name: string;
  description: string;
  scope: ToolScope;
  /** TypeBox схема. Работает и как JSON Schema для OpenAI, и как валидатор. */
  input: S;
  handler: (
    args: Static<S>,
    ctx: ToolContext,
  ) => ToolResult | Promise<ToolResult>;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDef>();

  register<S extends TSchema>(def: ToolDef<S>): void {
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

  /** Единая точка вызова: REST, MCP JSON-RPC и tool-runner. */
  async call(
    name: string,
    args: unknown,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) return { success: false, error: `Unknown tool: ${name}` };
    try {
      return await tool.handler(
        args as Static<typeof tool.input>,
        ctx,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  }
}

// Чтобы дочерние файлы могли использовать t без отдельного импорта.
export { t };
