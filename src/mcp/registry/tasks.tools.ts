import { t, type AgentToolContext, type ToolRegistry } from "./tool-registry";
import type { ToolResult } from "../types";

/**
 * Hippocampus rate-limit guard. Returns a pre-built `rate_limit` ToolResult
 * when the budget is exhausted, `null` otherwise (caller proceeds). Decrements
 * eagerly (attempt-based — failed upstream still consumes the slot, symmetric
 * with AgentLoopSession quotas). Applied to add/update/start/done/cancel.
 * `task_list` is read-only and skips the guard.
 */
function spendBudget(ctx: AgentToolContext): ToolResult | null {
  if (!ctx.taskBudget) return null;
  if (ctx.taskBudget.remaining <= 0) {
    return {
      success: false,
      error:
        "rate_limit: task mutation budget (3) spent for this exchange; finish or defer",
    };
  }
  ctx.taskBudget.remaining -= 1;
  return null;
}

const TASK_SCOPE = t.Union(
  [
    t.Literal("global"),
    t.Literal("autonomous"),
    t.Literal("free-agent"),
    t.Literal("freelance"),
    t.Literal("tg"),
  ],
  { default: "global", description: "Task scope (namespace)" },
);

const TASK_STATUS_FILTER = t.Union(
  [
    t.Literal("active"),
    t.Literal("open"),
    t.Literal("in_progress"),
    t.Literal("done"),
    t.Literal("cancelled"),
  ],
  { default: "active" },
);

export function registerTasksTools(registry: ToolRegistry): void {
  registry.register({
    name: "task_add",
    description:
      "Create a new task (or idempotently upsert by source). Use for TODO/reminder/deadline — not for general facts (those go to memory_write).",
    scope: "agent-only",
    input: t.Object({
      title: t.String({ description: "Short task title" }),
      description: t.Optional(t.String()),
      scope: t.Optional(TASK_SCOPE),
      due_at: t.Optional(
        t.Union([t.Number(), t.Null()], {
          description: "Due date, unix seconds (UTC)",
        }),
      ),
      priority: t.Optional(
        t.Integer({ minimum: 0, maximum: 10, default: 0 }),
      ),
      source: t.Optional(
        t.String({
          description:
            "Stable external key for idempotent upsert (e.g. 'tg:peer=123:msg=456')",
        }),
      ),
    }),
    handler: (args, ctx) => spendBudget(ctx) ?? ctx.executor.tasksTools.add(args),
  });

  registry.register({
    name: "task_list",
    description: "List tasks filtered by scope/status. Default: active only.",
    scope: "agent-only",
    input: t.Object({
      scope: t.Optional(TASK_SCOPE),
      status: t.Optional(TASK_STATUS_FILTER),
      limit: t.Optional(
        t.Integer({ minimum: 1, maximum: 200, default: 50 }),
      ),
    }),
    handler: (args, ctx) => ctx.executor.tasksTools.list(args),
  });

  registry.register({
    name: "task_update",
    description:
      "Patch title/description/priority/due_at. Does NOT change status — use task_start/done/cancel.",
    scope: "agent-only",
    input: t.Object({
      id: t.String(),
      title: t.Optional(t.String()),
      description: t.Optional(t.String()),
      priority: t.Optional(t.Integer({ minimum: 0, maximum: 10 })),
      due_at: t.Optional(t.Union([t.Number(), t.Null()])),
    }),
    handler: (args, ctx) =>
      spendBudget(ctx) ?? ctx.executor.tasksTools.update(args),
  });

  registry.register({
    name: "task_start",
    description: "Move task open → in_progress. Idempotent on in_progress.",
    scope: "agent-only",
    input: t.Object({ id: t.String() }),
    handler: (args, ctx) =>
      spendBudget(ctx) ?? ctx.executor.tasksTools.start(args),
  });

  registry.register({
    name: "task_done",
    description: "Close task as done with optional summary.",
    scope: "agent-only",
    input: t.Object({
      id: t.String(),
      summary: t.Optional(t.String()),
    }),
    handler: (args, ctx) =>
      spendBudget(ctx) ?? ctx.executor.tasksTools.done(args),
  });

  registry.register({
    name: "task_cancel",
    description: "Close task as cancelled with optional reason.",
    scope: "agent-only",
    input: t.Object({
      id: t.String(),
      reason: t.Optional(t.String()),
    }),
    handler: (args, ctx) =>
      spendBudget(ctx) ?? ctx.executor.tasksTools.cancel(args),
  });
}
