import { Database } from "bun:sqlite";
import type { TaskRow, TaskScope, TaskStatus } from "../types";
import { TERMINAL_STATUSES, InvalidTransitionError, canTransition } from "./task-transitions";

export { InvalidTransitionError };

export interface UpsertResult {
  id: string;
  created: boolean;
  /** True iff source already exists in terminal status — no-op, existing row returned. */
  skipped: boolean;
}

// DB CHECK enforces: status terminal ⇔ completed_at NOT NULL.
// upsertBySource never revives terminal rows. No reopen() in Phase 1.
export class TasksTable {
  constructor(public readonly db: Database) {}

  insert(task: {
    id: string;
    title: string;
    description?: string;
    scope: TaskScope;
    priority?: number;
    due_at?: number | null;
    source?: string | null;
  }): TaskRow {
    this.db
      .query(
        `INSERT INTO tasks (id, title, description, scope, priority, due_at, source)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.title,
        task.description ?? "",
        task.scope,
        task.priority ?? 0,
        task.due_at ?? null,
        task.source ?? null,
      );
    return this.get(task.id)!;
  }

  upsertBySource(
    source: string,
    fields: {
      scope: TaskScope;
      title: string;
      description?: string;
      priority?: number;
    },
    newId: string,
  ): UpsertResult {
    return this.db.transaction(() => {
      const ins = this.db
        .query(
          `INSERT OR IGNORE INTO tasks
           (id, title, description, scope, source, priority, status)
           VALUES (?, ?, ?, ?, ?, ?, 'open')`,
        )
        .run(
          newId,
          fields.title,
          fields.description ?? "",
          fields.scope,
          source,
          fields.priority ?? 0,
        );
      if (ins.changes === 1) {
        return { id: newId, created: true, skipped: false };
      }
      const existing = this.db
        .query(`SELECT id FROM tasks WHERE source = ?`)
        .get(source) as { id: string } | null;
      if (!existing) {
        throw new Error(
          `upsertBySource: conflict without row for source=${source}`,
        );
      }
      const upd = this.db
        .query(
          `UPDATE tasks SET
             title = ?,
             description = ?,
             priority = MAX(priority, ?),
             updated_at = unixepoch()
           WHERE source = ? AND status IN ('open','in_progress')`,
        )
        .run(
          fields.title,
          fields.description ?? "",
          fields.priority ?? 0,
          source,
        );
      if (upd.changes === 1) {
        return { id: existing.id, created: false, skipped: false };
      }
      return { id: existing.id, created: false, skipped: true };
    })();
  }

  get(id: string): TaskRow | null {
    return (
      (this.db.query(`SELECT * FROM tasks WHERE id = ?`).get(id) as
        | TaskRow
        | null) ?? null
    );
  }

  list(opts: {
    scope?: TaskScope;
    status?: TaskStatus | "active";
    limit: number;
    offset: number;
  }): { items: TaskRow[]; total: number } {
    const where: string[] = [];
    const params: (string | number | null)[] = [];
    if (opts.scope) {
      where.push("scope = ?");
      params.push(opts.scope);
    }
    if (opts.status === "active") {
      where.push("status IN ('open','in_progress')");
    } else if (opts.status) {
      where.push("status = ?");
      params.push(opts.status);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const items = this.db
      .query(
        `SELECT * FROM tasks ${whereSql}
         ORDER BY priority DESC, due_at IS NULL, due_at ASC, id ASC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, opts.limit, opts.offset) as TaskRow[];
    const total = (
      this.db
        .query(`SELECT COUNT(*) AS c FROM tasks ${whereSql}`)
        .get(...params) as { c: number }
    ).c;
    return { items, total };
  }

  listActive(scope: TaskScope, limit: number): TaskRow[] {
    return this.db
      .query(
        `SELECT * FROM tasks
         WHERE scope = ? AND status IN ('open','in_progress')
         ORDER BY priority DESC, due_at IS NULL, due_at ASC, id ASC
         LIMIT ?`,
      )
      .all(scope, limit) as TaskRow[];
  }

  countActive(scope: TaskScope): number {
    return (
      this.db
        .query(
          `SELECT COUNT(*) AS c FROM tasks
           WHERE scope = ? AND status IN ('open','in_progress')`,
        )
        .get(scope) as { c: number }
    ).c;
  }

  update(
    id: string,
    fields: {
      title?: string;
      description?: string;
      priority?: number;
      due_at?: number | null;
    },
  ): TaskRow | null {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (fields.title !== undefined) {
      sets.push("title = ?");
      params.push(fields.title);
    }
    if (fields.description !== undefined) {
      sets.push("description = ?");
      params.push(fields.description);
    }
    if (fields.priority !== undefined) {
      sets.push("priority = ?");
      params.push(fields.priority);
    }
    if (fields.due_at !== undefined) {
      sets.push("due_at = ?");
      params.push(fields.due_at);
    }
    if (sets.length === 0) return this.get(id);
    sets.push("updated_at = unixepoch()");
    params.push(id);
    this.db
      .query(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`)
      .run(...params);
    return this.get(id);
  }

  /**
   * Atomic status transition. Sets/unsets completed_at automatically.
   * Throws InvalidTransitionError on illegal transitions.
   */
  transition(id: string, to: TaskStatus): TaskRow {
    return this.db.transaction(() => {
      const row = this.get(id);
      if (!row) throw new Error(`task_not_found: ${id}`);
      if (!canTransition(row.status, to)) {
        throw new InvalidTransitionError(row.status, to);
      }
      if (row.status === to) return row;
      const completedClause = TERMINAL_STATUSES.has(to)
        ? ", completed_at = unixepoch()"
        : ", completed_at = NULL";
      this.db
        .query(
          `UPDATE tasks SET status = ?, updated_at = unixepoch()${completedClause}
           WHERE id = ?`,
        )
        .run(to, id);
      return this.get(id)!;
    })();
  }

  delete(id: string): boolean {
    return this.db.query(`DELETE FROM tasks WHERE id = ?`).run(id).changes > 0;
  }

  listCompletedSince(opts: {
    scope?: TaskScope;
    sinceUnix: number;
    limit: number;
    offset: number;
  }): { items: TaskRow[]; total: number } {
    const where = ["status IN ('done','cancelled')", "completed_at >= ?"];
    const params: (string | number | null)[] = [opts.sinceUnix];
    if (opts.scope) {
      where.push("scope = ?");
      params.push(opts.scope);
    }
    const whereSql = `WHERE ${where.join(" AND ")}`;
    const items = this.db
      .query(
        `SELECT * FROM tasks ${whereSql}
         ORDER BY completed_at DESC, id ASC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, opts.limit, opts.offset) as TaskRow[];
    const total = (
      this.db
        .query(`SELECT COUNT(*) AS c FROM tasks ${whereSql}`)
        .get(...params) as { c: number }
    ).c;
    return { items, total };
  }
}
