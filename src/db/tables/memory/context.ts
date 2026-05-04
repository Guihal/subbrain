import { Database } from "bun:sqlite";
import type { ContextRow, MemoryStatus } from "../../types";
import { updateRow } from "../update-row";
import {
  buildActiveFilter,
  CONTEXT_UPDATABLE,
  type InsertContextOpts,
} from "./helpers";

export function insertContext(
  db: Database,
  id: string,
  title: string,
  content: string,
  tags: string,
  derivedFrom: string[],
  agentId: string | undefined,
  opts: InsertContextOpts | undefined,
): void {
  const conf = opts?.confidence ?? null;
  const status = opts?.status ?? "active";
  const expiresAt = opts?.expires_at ?? null;
  db.query(
    "INSERT INTO layer2_context (id, title, content, tags, derived_from, agent_id, confidence, status, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    title,
    content,
    tags,
    JSON.stringify(derivedFrom),
    agentId ?? null,
    conf,
    status,
    expiresAt,
  );
}

export function updateContext(
  db: Database,
  id: string,
  fields: {
    title?: string;
    content?: string;
    tags?: string;
    status?: MemoryStatus;
    confidence?: number | null;
    expires_at?: number | null;
    superseded_by?: string | null;
    derived_from?: string;
  },
): void {
  updateRow(db, "layer2_context", CONTEXT_UPDATABLE, id, fields);
}

export function getContext(db: Database, id: string): ContextRow | null {
  return db
    .query("SELECT * FROM layer2_context WHERE id = ?")
    .get(id) as ContextRow | null;
}

/**
 * Batch-lookup context rows by id. `activeOnly` (PR 22a / MEM-5) filters out
 * pending/rejected rows. `notStale` (MEM-6, mig 9) filters out superseded /
 * expired rows. `agentId` (B-1) restricts to the caller's own private rows
 * + global (NULL) rows; absent → no agent filter (admin scope).
 */
export function getContextMany(
  db: Database,
  ids: string[],
  opts?: { activeOnly?: boolean; notStale?: boolean; agentId?: string },
): ContextRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const filter = buildActiveFilter("layer2_context", opts);
  const agentFilter = opts?.agentId
    ? " AND (agent_id = ? OR agent_id IS NULL)"
    : "";
  const params: (string | number)[] = [...ids];
  if (opts?.agentId) params.push(opts.agentId);
  return db
    .query(
      `SELECT * FROM layer2_context WHERE id IN (${placeholders})${filter}${agentFilter}`,
    )
    .all(...params) as ContextRow[];
}

export function listContext(
  db: Database,
  limit = 50,
  offset = 0,
): ContextRow[] {
  return db
    .query(
      "SELECT * FROM layer2_context ORDER BY updated_at DESC LIMIT ? OFFSET ?",
    )
    .all(limit, offset) as ContextRow[];
}

/** MEM-6: list-with-fresh-filter helper for admin `?active=true`. See
 * shared.ts:listSharedActive for the rationale. */
export function listContextActive(
  db: Database,
  limit = 50,
  offset = 0,
): { items: ContextRow[]; total: number } {
  const filter = buildActiveFilter("layer2_context", {
    activeOnly: true,
    notStale: true,
  });
  const items = db
    .query(
      `SELECT * FROM layer2_context WHERE 1=1 ${filter} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
    )
    .all(limit, offset) as ContextRow[];
  const totalRow = db
    .query(
      `SELECT COUNT(*) AS c FROM layer2_context WHERE 1=1 ${filter}`,
    )
    .get() as { c: number };
  return { items, total: totalRow.c };
}

export function countContext(db: Database): number {
  const row = db
    .query("SELECT COUNT(*) AS c FROM layer2_context")
    .get() as { c: number };
  return row.c;
}

/** PR-B: return all context rows (janitor bulk scan). */
export function getAllContext(db: Database): ContextRow[] {
  return db.query("SELECT * FROM layer2_context ORDER BY updated_at DESC").all() as ContextRow[];
}

export function deleteContext(db: Database, id: string): void {
  db.query("DELETE FROM layer2_context WHERE id = ?").run(id);
}
