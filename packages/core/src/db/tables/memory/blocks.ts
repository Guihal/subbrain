import type { Database } from "bun:sqlite";
import type { BlockRow } from "../../types";
import { updateRow } from "../update-row";

const BLOCKS_UPDATABLE = new Set(["owner_role", "label", "body"]);

export function insertBlock(
  db: Database,
  id: string,
  ownerRole: string,
  label: string,
  body: string,
): void {
  const now = Math.floor(Date.now() / 1000);
  db.query(
    "INSERT INTO memory_blocks (id, owner_role, label, body, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, 1)",
  ).run(id, ownerRole, label, body, now, now);
}

export function updateBlock(
  db: Database,
  id: string,
  fields: { owner_role?: string; label?: string; body?: string },
): void {
  const patch = { ...fields, version: undefined as unknown as number };
  updateRow(db, "memory_blocks", BLOCKS_UPDATABLE, id, patch);
  db.query(
    "UPDATE memory_blocks SET version = version + 1, updated_at = ? WHERE id = ?",
  ).run(Math.floor(Date.now() / 1000), id);
}

export function getBlock(db: Database, id: string): BlockRow | null {
  return db.query("SELECT * FROM memory_blocks WHERE id = ?").get(id) as BlockRow | null;
}

export function getBlockByLabel(
  db: Database,
  ownerRole: string,
  label: string,
): BlockRow | null {
  return db
    .query("SELECT * FROM memory_blocks WHERE owner_role = ? AND label = ?")
    .get(ownerRole, label) as BlockRow | null;
}

export function listBlocks(db: Database, limit = 50, offset = 0): BlockRow[] {
  return db
    .query("SELECT * FROM memory_blocks ORDER BY updated_at DESC LIMIT ? OFFSET ?")
    .all(limit, offset) as BlockRow[];
}

export function listBlocksByRole(db: Database, ownerRole: string): BlockRow[] {
  return db
    .query("SELECT * FROM memory_blocks WHERE owner_role = ? ORDER BY label")
    .all(ownerRole) as BlockRow[];
}

export function countBlocks(db: Database): number {
  const row = db.query("SELECT COUNT(*) AS c FROM memory_blocks").get() as { c: number };
  return row.c;
}

export function deleteBlock(db: Database, id: string): void {
  db.query("DELETE FROM memory_blocks WHERE id = ?").run(id);
}
