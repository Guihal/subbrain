/**
 * Memory blocks (P3-5, mig 18).
 * Editable named text fragments scoped per role.
 * Unique constraint on (owner_role, label) — one block per role+label pair.
 */
import type { Database } from "bun:sqlite";
import type { BlockRow } from "../../types";

export function insertBlock(
  db: Database,
  id: string,
  ownerRole: string,
  label: string,
  body: string,
): void {
  const now = Math.floor(Date.now() / 1000);
  db.query(
    `INSERT INTO memory_blocks (id, owner_role, label, body, created_at, updated_at, version)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
  ).run(id, ownerRole, label, body, now, now);
}

export function updateBlock(
  db: Database,
  id: string,
  fields: { owner_role?: string; label?: string; body?: string },
): boolean {
  const sets: string[] = [];
  const vals: (string | number)[] = [];
  if (fields.owner_role !== undefined) {
    sets.push("owner_role = ?");
    vals.push(fields.owner_role);
  }
  if (fields.label !== undefined) {
    sets.push("label = ?");
    vals.push(fields.label);
  }
  if (fields.body !== undefined) {
    sets.push("body = ?");
    vals.push(fields.body);
  }
  if (sets.length === 0) return false;
  sets.push("updated_at = ?");
  vals.push(Math.floor(Date.now() / 1000));
  sets.push("version = version + 1");
  vals.push(id);
  const sql = `UPDATE memory_blocks SET ${sets.join(", ")} WHERE id = ?`;
  const info = db.query(sql).run(...vals);
  return info.changes > 0;
}

export function getBlock(db: Database, id: string): BlockRow | null {
  return db.query<BlockRow, [string]>(
    `SELECT id, owner_role, label, body, created_at, updated_at, version
     FROM memory_blocks WHERE id = ?`,
  ).get(id) ?? null;
}

export function getBlockByLabel(
  db: Database,
  ownerRole: string,
  label: string,
): BlockRow | null {
  return db.query<BlockRow, [string, string]>(
    `SELECT id, owner_role, label, body, created_at, updated_at, version
     FROM memory_blocks WHERE owner_role = ? AND label = ?`,
  ).get(ownerRole, label) ?? null;
}

export function listBlocks(
  db: Database,
  limit?: number,
  offset?: number,
): BlockRow[] {
  const sql =
    `SELECT id, owner_role, label, body, created_at, updated_at, version
     FROM memory_blocks
     ORDER BY updated_at DESC` +
    (limit !== undefined ? ` LIMIT ${Math.max(0, limit)}` : "") +
    (offset !== undefined ? ` OFFSET ${Math.max(0, offset)}` : "");
  return db.query<BlockRow, []>(sql).all();
}

export function listBlocksByRole(db: Database, ownerRole: string): BlockRow[] {
  return db.query<BlockRow, [string]>(
    `SELECT id, owner_role, label, body, created_at, updated_at, version
     FROM memory_blocks WHERE owner_role = ? ORDER BY updated_at DESC`,
  ).all(ownerRole);
}

export function countBlocks(db: Database): number {
  return db.query<{ c: number }, []>("SELECT count(*) AS c FROM memory_blocks").get()?.c ?? 0;
}

export function deleteBlock(db: Database, id: string): boolean {
  const info = db.query("DELETE FROM memory_blocks WHERE id = ?").run(id);
  return info.changes > 0;
}
