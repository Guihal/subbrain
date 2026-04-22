import { randomUUID } from "node:crypto";
import type { MemoryDB } from "../../db";
import type { TaskScope, TaskStatus } from "../../db";
import { InvalidTransitionError } from "../../db";
import type { ToolResult } from "../types";
import { logger } from "../../lib/logger";

const log = logger.child("tasks.tools");

/**
 * Domain logic for task_* MCP tools. Registry handlers (registry/tasks.tools.ts)
 * delegate here so the same logic is reachable from REST and agent-loop.
 *
 * All handlers return ToolResult: {success, data?, error?} where `error` is a
 * colon-prefixed code string (e.g. "invalid_transition: open → open"), parseable
 * by the agent model in the failure branch.
 */
export class TasksTools {
  constructor(private memory: MemoryDB) {}

  add(args: {
    title: string;
    description?: string;
    scope?: TaskScope;
    due_at?: number | null;
    priority?: number;
    source?: string;
  }): ToolResult {
    if (!args.title || typeof args.title !== "string") {
      return { success: false, error: "validation: title required" };
    }
    const id = randomUUID();
    try {
      if (args.source) {
        const res = this.memory.upsertTaskBySource(
          args.source,
          {
            scope: args.scope ?? "global",
            title: args.title,
            description: args.description,
            priority: args.priority ?? 0,
          },
          id,
        );
        return { success: true, data: res };
      }
      const row = this.memory.insertTask({
        id,
        title: args.title,
        description: args.description,
        scope: args.scope ?? "global",
        priority: args.priority ?? 0,
        due_at: args.due_at ?? null,
      });
      return { success: true, data: { id: row.id, created: true, skipped: false } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`add failed: ${msg}`);
      return { success: false, error: `insert_failed: ${msg}` };
    }
  }

  list(args: {
    scope?: TaskScope;
    status?: TaskStatus | "active";
    limit?: number;
  }): ToolResult {
    const limit = Math.min(args.limit ?? 50, 200);
    const { items, total } = this.memory.listTasks({
      scope: args.scope,
      status: args.status ?? "active",
      limit,
      offset: 0,
    });
    return { success: true, data: { items, total } };
  }

  update(args: {
    id: string;
    title?: string;
    description?: string;
    priority?: number;
    due_at?: number | null;
  }): ToolResult {
    const existing = this.memory.getTask(args.id);
    if (!existing) return { success: false, error: `not_found: ${args.id}` };
    const updated = this.memory.updateTask(args.id, {
      title: args.title,
      description: args.description,
      priority: args.priority,
      due_at: args.due_at,
    });
    return { success: true, data: updated };
  }

  start(args: { id: string }): ToolResult {
    return this.transition(args.id, "in_progress");
  }

  done(args: { id: string; summary?: string }): ToolResult {
    const res = this.transition(args.id, "done");
    if (res.success && args.summary) {
      // summary is free-form; persisted into description so /history shows it.
      this.memory.updateTask(args.id, {
        description: this.appendSummary(args.id, args.summary, "done"),
      });
      return { success: true, data: this.memory.getTask(args.id) };
    }
    return res;
  }

  cancel(args: { id: string; reason?: string }): ToolResult {
    const res = this.transition(args.id, "cancelled");
    if (res.success && args.reason) {
      this.memory.updateTask(args.id, {
        description: this.appendSummary(args.id, args.reason, "cancelled"),
      });
      return { success: true, data: this.memory.getTask(args.id) };
    }
    return res;
  }

  private transition(id: string, to: TaskStatus): ToolResult {
    const existing = this.memory.getTask(id);
    if (!existing) return { success: false, error: `not_found: ${id}` };
    try {
      const row = this.memory.transitionTask(id, to);
      return { success: true, data: row };
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        return {
          success: false,
          error: `invalid_transition: ${err.from} → ${err.to}`,
        };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `transition_failed: ${msg}` };
    }
  }

  private appendSummary(id: string, text: string, label: string): string {
    const row = this.memory.getTask(id);
    const prev = row?.description ?? "";
    const sep = prev.length > 0 ? "\n\n" : "";
    return `${prev}${sep}[${label}] ${text}`;
  }
}
