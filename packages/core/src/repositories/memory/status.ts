import type { Database } from "bun:sqlite";
import type { ContextRow, MemoryStatus, SharedRow } from "../../db/index";
import type { MemoryTable } from "../../db/tables/memory";
import type { SharedTable } from "../../db/tables/shared";

export type PendingLayer = "shared" | "context";

/**
 * Previously lived in `MemoryService.listByStatus` (raw SQL leak that the
 * boundary-test now blocks). Folded back to the repo layer where it belongs.
 * Table comes from a 2-value union — no injection surface.
 */
export function listByStatus(
  db: Database,
  layer: PendingLayer,
  status: MemoryStatus,
  limit: number,
  offset: number,
): { items: (SharedRow | ContextRow)[]; total: number } {
  const table = layer === "shared" ? "shared_memory" : "layer2_context";
  const items = db
    .query(`SELECT * FROM ${table} WHERE status = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
    .all(status, limit, offset) as (SharedRow | ContextRow)[];
  const row = db.query(`SELECT COUNT(*) AS c FROM ${table} WHERE status = ?`).get(status) as {
    c: number;
  };
  return { items, total: row.c };
}

/**
 * Single source of truth for pending-approval status flips (PR 22b).
 * 404-semantics live here: `null` → caller throws NotFoundError.
 * `bun:sqlite` single-conn serializes BEGIN..COMMIT so a mid-tx delete is
 * physically impossible under the default runtime config.
 */
export function setStatusSafe(
  db: Database,
  mem: MemoryTable,
  shared: SharedTable,
  layer: PendingLayer,
  id: string,
  status: MemoryStatus,
): SharedRow | ContextRow | null {
  return db.transaction(() => {
    if (layer === "shared") {
      if (!shared.getShared(id)) return null;
      shared.updateShared(id, { status });
      return shared.getShared(id);
    }
    if (!mem.getContext(id)) return null;
    mem.updateContext(id, { status });
    return mem.getContext(id);
  })();
}

/**
 * Mark a row as superseded. `by` is one of:
 *   - a UUID-shaped row id (the row that replaces this one), OR
 *   - the literal string 'expired' (used by the night-cycle expiry pass).
 *
 * Sentinel + row-id share one column intentionally — collision is impossible
 * because randomUUID() never produces "expired". Wraps `updateShared` /
 * `updateContext` so SQL stays in `tables/*` (boundary test stays green).
 * Caller validates `by` exists; the BEFORE-UPDATE trigger only blocks
 * self-supersede (id == NEW.superseded_by).
 */
export function setSupersededBy(
  mem: MemoryTable,
  shared: SharedTable,
  layer: PendingLayer,
  id: string,
  by: string,
): void {
  if (layer === "shared") shared.updateShared(id, { superseded_by: by });
  else mem.updateContext(id, { superseded_by: by });
}
