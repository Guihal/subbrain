/**
 * UI types for the tasks store.
 *
 * SSOT: TaskScope / TaskStatus / TaskRow enums live in
 * src/db/types.ts:131-137 on the backend. Nuxt cannot import from there
 * directly (no tsconfig alias into `src/`), so values are duplicated here.
 * Keep in sync when the backend enum changes — verify with:
 *   git grep "export type TaskScope" src/db/types.ts web/app/types/task.ts
 */
export type TaskScope =
  | "global"
  | "autonomous"
  | "free-agent"
  | "freelance"
  | "tg";

export type TaskStatus = "open" | "in_progress" | "done" | "cancelled";

export interface TaskRow {
  id: string;
  title: string;
  description: string;
  scope: TaskScope;
  status: TaskStatus;
  priority: number;
  due_at: number | null;
  source: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface CreateBody {
  title: string;
  description?: string;
  scope?: TaskScope;
  priority?: number;
  due_at?: number | null;
}

/**
 * Status transitions allowed by the backend PATCH endpoint:
 *   open → in_progress | done | cancelled
 *   in_progress → done | cancelled
 *   done, cancelled — terminal (no reopen).
 */
export interface PatchBody {
  title?: string;
  description?: string;
  priority?: number;
  due_at?: number | null;
  status?: "in_progress" | "done" | "cancelled";
}

export type StatusFilter = TaskStatus | "active" | "all";

export interface TaskFilters {
  scope?: TaskScope;
  status: StatusFilter;
  page: number;
  page_size: number;
  q: string;
}

export interface DigestRow {
  id: string;
  title: string;
  content: string;
  tags: string;
  created_at: number;
}

export type HistoryItem =
  | ({ kind: "task" } & TaskRow)
  | ({ kind: "digest" } & DigestRow);

export interface ListEnvelope<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

export const TASK_SCOPES: readonly TaskScope[] = [
  "global",
  "autonomous",
  "free-agent",
  "freelance",
  "tg",
] as const;
