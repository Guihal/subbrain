import type { Database } from "bun:sqlite";
import type { ArchiveRow } from "../../types";
import { updateRow } from "../update-row";
import { ARCHIVE_UPDATABLE } from "./helpers";

// M-12 (mig 15): confidence is REAL [0..1] | null. Legacy default of 'HIGH'
// becomes 0.9 — same status='active' equivalence as the backfill mapping.
// Out-of-range values are clamped at the route boundary
// (TypeBox `t.Number({minimum:0, maximum:1})` in routes/memory.ts); direct
// DB callers (night cycle, scripts) pass numeric confidence explicitly.
export function insertArchive(
  db: Database,
  id: string,
  title: string,
  content: string,
  tags: string,
  sourceRequestIds: string[],
  confidence: number | null,
  agentId?: string,
): void {
  db.query(
    "INSERT INTO layer3_archive (id, title, content, tags, source_request_ids, confidence, agent_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, title, content, tags, JSON.stringify(sourceRequestIds), confidence, agentId ?? null);
}

export function getArchive(db: Database, id: string): ArchiveRow | null {
  return db.query("SELECT * FROM layer3_archive WHERE id = ?").get(id) as ArchiveRow | null;
}

export function getArchiveMany(db: Database, ids: string[]): ArchiveRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  return db
    .query(`SELECT * FROM layer3_archive WHERE id IN (${placeholders})`)
    .all(...ids) as ArchiveRow[];
}

export function listArchive(db: Database, limit = 50, offset = 0): ArchiveRow[] {
  return db
    .query("SELECT * FROM layer3_archive ORDER BY updated_at DESC LIMIT ? OFFSET ?")
    .all(limit, offset) as ArchiveRow[];
}

export function countArchive(db: Database): number {
  const row = db.query("SELECT COUNT(*) AS c FROM layer3_archive").get() as { c: number };
  return row.c;
}

// M-12: confidence REAL [0..1] | null. updateRow allow-list unchanged.
export function updateArchive(
  db: Database,
  id: string,
  fields: {
    title?: string;
    content?: string;
    tags?: string;
    confidence?: number | null;
  },
): void {
  updateRow(db, "layer3_archive", ARCHIVE_UPDATABLE, id, fields);
}

export function deleteArchive(db: Database, id: string): void {
  db.query("DELETE FROM layer3_archive WHERE id = ?").run(id);
}
