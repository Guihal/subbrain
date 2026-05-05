/**
 * TaskRepository — W2-2. Wraps `MemoryDB.tasks` facade methods used by the
 * `/v1/tasks` route + owns `buildHistoryLoader` (was inline in routes/tasks).
 *
 * Routes consume this instead of `MemoryDB` directly so the route file holds
 * no SQL and stays under the 150-line cap (SoC: routes = view layer).
 */
import type { MemoryDB, TaskRow, TaskScope, TaskStatus } from "../db";

export class TaskRepository {
  constructor(private readonly memory: MemoryDB) {}

  listTasks = (opts: {
    scope?: TaskScope;
    status?: TaskStatus | "active";
    limit: number;
    offset: number;
  }): { items: TaskRow[]; total: number } => this.memory.listTasks(opts);

  insertTask = (task: {
    id: string;
    title: string;
    description?: string;
    scope: TaskScope;
    priority?: number;
    due_at?: number | null;
    source?: string | null;
  }): TaskRow => this.memory.insertTask(task);

  getTask = (id: string): TaskRow | null => this.memory.getTask(id);

  updateTask = (
    id: string,
    fields: {
      title?: string;
      description?: string;
      priority?: number;
      due_at?: number | null;
    },
  ): TaskRow | null => this.memory.updateTask(id, fields);

  transitionTask = (id: string, to: TaskStatus): TaskRow => this.memory.transitionTask(id, to);

  deleteTask = (id: string): boolean => this.memory.deleteTask(id);

  transaction = <T>(fn: () => T): T => this.memory.transaction(fn);

  /**
   * /history page-loader: live completed tasks first (DESC completed_at,
   * honoring `scope`), then weekly digests (DESC created_at, cross-scope).
   * Pagination exhausts all live rows before any digest is returned;
   * `total = live.total + digestTotal`.
   */
  buildHistoryLoader(scope: TaskScope | undefined, sinceUnix: number) {
    return (limit: number, offset: number) => {
      const live = this.memory.listCompletedTasksSince({
        scope,
        sinceUnix,
        limit,
        offset,
      });
      const remaining = limit - live.items.length;
      const digestOffset = Math.max(0, offset - live.total);
      const digests =
        remaining > 0 ? this.memory.searchTaskDigests(sinceUnix, remaining, digestOffset) : [];
      const digestTotal = this.memory.countTaskDigestsSince(sinceUnix);
      return {
        items: [
          ...live.items.map((t) => ({ kind: "task" as const, ...t })),
          ...digests.map((d) => ({ kind: "digest" as const, ...d })),
        ],
        total: live.total + digestTotal,
      };
    };
  }
}
