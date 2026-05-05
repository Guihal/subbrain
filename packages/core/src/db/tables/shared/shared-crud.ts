import type { Database } from "bun:sqlite";
import type { MemoryKind, MemoryStatus, SharedRow } from "../../types";
import { updateRow } from "../update-row";
import { buildActiveFilter, type InsertSharedOpts, SHARED_UPDATABLE } from "./helpers";

export function insertShared(
  db: Database,
  id: string,
  category: string,
  content: string,
  tags: string,
  source: string | undefined,
  opts: InsertSharedOpts | undefined,
): void {
  const conf = opts?.confidence ?? null;
  const status = opts?.status ?? "active";
  const kind: MemoryKind = opts?.kind ?? "semantic";
  const expiresAt = opts?.expires_at ?? null;
  const validFrom = opts?.valid_from ?? null;
  const validTo = opts?.valid_to ?? null;
  const observedAt = opts?.observed_at ?? null;
  db.query(
    "INSERT INTO shared_memory (id, category, content, tags, source, confidence, status, kind, expires_at, valid_from, valid_to, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    category,
    content,
    tags,
    source ?? null,
    conf,
    status,
    kind,
    expiresAt,
    validFrom,
    validTo,
    observedAt,
  );
}

export function getAllShared(db: Database): SharedRow[] {
  return db.query("SELECT * FROM shared_memory ORDER BY updated_at DESC").all() as SharedRow[];
}

// M-07: optional `kind` filter. Composes with category AND-wise.
function whereCategoryKind(
  category?: string,
  kind?: MemoryKind,
): { sql: string; params: (string | number)[] } {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (category) {
    where.push("category = ?");
    params.push(category);
  }
  if (kind) {
    where.push("kind = ?");
    params.push(kind);
  }
  return { sql: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
}

export function listShared(
  db: Database,
  limit: number,
  offset: number,
  category: string | undefined,
  kind: MemoryKind | undefined,
): SharedRow[] {
  const { sql, params } = whereCategoryKind(category, kind);
  return db
    .query(`SELECT * FROM shared_memory ${sql} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as SharedRow[];
}

/**
 * MEM-6: list-with-fresh-filter helper. Used by admin `?active=true` only —
 * default admin path stays through `listShared` and continues to show every
 * row including expired/superseded for audit. Pagination + total are filtered
 * symmetrically so the UI doesn't show "1234 results" when only 5 are live.
 */
export function listSharedActive(
  db: Database,
  limit: number,
  offset: number,
  category: string | undefined,
): { items: SharedRow[]; total: number } {
  const filter = buildActiveFilter("shared_memory", {
    activeOnly: true,
    notStale: true,
  });
  const where = category ? `WHERE category = ? ${filter}` : `WHERE 1=1 ${filter}`;
  const params: (string | number)[] = category ? [category] : [];
  const items = db
    .query(`SELECT * FROM shared_memory ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as SharedRow[];
  const totalRow = db.query(`SELECT COUNT(*) AS c FROM shared_memory ${where}`).get(...params) as {
    c: number;
  };
  return { items, total: totalRow.c };
}

export function countShared(db: Database, category?: string, kind?: MemoryKind): number {
  const { sql, params } = whereCategoryKind(category, kind);
  const row = db.query(`SELECT COUNT(*) AS c FROM shared_memory ${sql}`).get(...params) as {
    c: number;
  };
  return row.c;
}

export function getShared(db: Database, id: string): SharedRow | null {
  return db.query("SELECT * FROM shared_memory WHERE id = ?").get(id) as SharedRow | null;
}

/**
 * Batch-lookup shared rows. `activeOnly` (PR 22a / MEM-5) filters out
 * pending/rejected rows. `notStale` (MEM-6, mig 9) filters out
 * superseded/expired rows. Both used by RAG injection so unapproved or
 * expired facts never reach model context. Filters compose AND-wise.
 */
export function getSharedMany(
  db: Database,
  ids: string[],
  opts?: { activeOnly?: boolean; notStale?: boolean },
): SharedRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const filter = buildActiveFilter("shared_memory", opts);
  return db
    .query(`SELECT * FROM shared_memory WHERE id IN (${placeholders})${filter}`)
    .all(...ids) as SharedRow[];
}

export function getSharedByCategory(db: Database, category: string): SharedRow[] {
  return db
    .query("SELECT * FROM shared_memory WHERE category = ? ORDER BY updated_at DESC")
    .all(category) as SharedRow[];
}

export function updateShared(
  db: Database,
  id: string,
  fields: {
    content?: string;
    tags?: string;
    category?: string;
    status?: MemoryStatus;
    confidence?: number | null;
    expires_at?: number | null;
    superseded_by?: string | null;
    kind?: MemoryKind;
    valid_from?: number | null;
    valid_to?: number | null;
    observed_at?: number | null;
  },
): void {
  updateRow(db, "shared_memory", SHARED_UPDATABLE, id, fields);
}

export function deleteShared(db: Database, id: string): void {
  db.query("DELETE FROM shared_memory WHERE id = ?").run(id);
}
