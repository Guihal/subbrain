import type { TaskStatus } from "../types";

export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "done",
  "cancelled",
]);

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: TaskStatus,
    public readonly to: TaskStatus,
  ) {
    super(`invalid_transition: ${from} → ${to}`);
    this.name = "InvalidTransitionError";
  }
}

/**
 * Allowed transitions:
 *   open → in_progress | done | cancelled
 *   in_progress → done | cancelled
 *   same→same: idempotent no-op (for task_start on already in_progress, etc.)
 *   terminal → anything: rejected.
 */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return !TERMINAL_STATUSES.has(from);
  if (TERMINAL_STATUSES.has(from)) return false;
  if (from === "open" && (to === "in_progress" || TERMINAL_STATUSES.has(to)))
    return true;
  if (from === "in_progress" && TERMINAL_STATUSES.has(to)) return true;
  return false;
}
