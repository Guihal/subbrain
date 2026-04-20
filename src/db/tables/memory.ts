import { Database, type SQLQueryBindings } from "bun:sqlite";
import { sanitizeFtsQuery } from "../../lib/fts-utils";
import type { ContextRow, ArchiveRow, FtsResult } from "../types";

export class MemoryTable {
  constructor(public readonly db: Database) {}

  // ─── Layer 1: Focus ────────────────────────────────────────

  getFocus(key: string): string | null {
    const row = this.db
      .query("SELECT value FROM layer1_focus WHERE key = ?")
      .get(key) as { value: string } | null;
    return row?.value ?? null;
  }

  setFocus(key: string, value: string): void {
    this.db
      .query(
        "INSERT INTO layer1_focus (key, value, updated_at) VALUES (?, ?, unixepoch()) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      )
      .run(key, value);
  }

  getAllFocus(): Record<string, string> {
    const rows = this.db.query("SELECT key, value FROM layer1_focus").all() as {
      key: string;
      value: string;
    }[];
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  deleteFocus(key: string): void {
    this.db.query("DELETE FROM layer1_focus WHERE key = ?").run(key);
  }

  // ─── Layer 2: Context ──────────────────────────────────────

  insertContext(
    id: string,
    title: string,
    content: string,
    tags: string = "",
    derivedFrom: string[] = [],
    agentId?: string,
  ): void {
    this.db
      .query(
        "INSERT INTO layer2_context (id, title, content, tags, derived_from, agent_id) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, title, content, tags, JSON.stringify(derivedFrom), agentId ?? null);
  }

  updateContext(
    id: string,
    fields: { title?: string; content?: string; tags?: string },
  ): void {
    const sets: string[] = ["updated_at = unixepoch()"];
    const vals: SQLQueryBindings[] = [];
    if (fields.title !== undefined) { sets.push("title = ?"); vals.push(fields.title); }
    if (fields.content !== undefined) { sets.push("content = ?"); vals.push(fields.content); }
    if (fields.tags !== undefined) { sets.push("tags = ?"); vals.push(fields.tags); }
    vals.push(id);
    this.db.query(`UPDATE layer2_context SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  }

  getContext(id: string): ContextRow | null {
    return this.db
      .query("SELECT * FROM layer2_context WHERE id = ?")
      .get(id) as ContextRow | null;
  }

  listContext(limit = 50, offset = 0): ContextRow[] {
    return this.db
      .query("SELECT * FROM layer2_context ORDER BY updated_at DESC LIMIT ? OFFSET ?")
      .all(limit, offset) as ContextRow[];
  }

  countContext(): number {
    const row = this.db.query("SELECT COUNT(*) AS c FROM layer2_context").get() as { c: number };
    return row.c;
  }

  deleteContext(id: string): void {
    this.db.query("DELETE FROM layer2_context WHERE id = ?").run(id);
  }

  // ─── Layer 3: Archive ──────────────────────────────────────

  insertArchive(
    id: string,
    title: string,
    content: string,
    tags: string = "",
    sourceRequestIds: string[] = [],
    confidence: "HIGH" | "LOW" = "HIGH",
    agentId?: string,
  ): void {
    this.db
      .query(
        "INSERT INTO layer3_archive (id, title, content, tags, source_request_ids, confidence, agent_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, title, content, tags, JSON.stringify(sourceRequestIds), confidence, agentId ?? null);
  }

  getArchive(id: string): ArchiveRow | null {
    return this.db
      .query("SELECT * FROM layer3_archive WHERE id = ?")
      .get(id) as ArchiveRow | null;
  }

  listArchive(limit = 50, offset = 0): ArchiveRow[] {
    return this.db
      .query("SELECT * FROM layer3_archive ORDER BY updated_at DESC LIMIT ? OFFSET ?")
      .all(limit, offset) as ArchiveRow[];
  }

  countArchive(): number {
    const row = this.db.query("SELECT COUNT(*) AS c FROM layer3_archive").get() as { c: number };
    return row.c;
  }

  updateArchive(
    id: string,
    fields: { title?: string; content?: string; tags?: string; confidence?: "HIGH" | "LOW" },
  ): void {
    const sets: string[] = ["updated_at = unixepoch()"];
    const vals: SQLQueryBindings[] = [];
    if (fields.title !== undefined) { sets.push("title = ?"); vals.push(fields.title); }
    if (fields.content !== undefined) { sets.push("content = ?"); vals.push(fields.content); }
    if (fields.tags !== undefined) { sets.push("tags = ?"); vals.push(fields.tags); }
    if (fields.confidence !== undefined) { sets.push("confidence = ?"); vals.push(fields.confidence); }
    vals.push(id);
    this.db.query(`UPDATE layer3_archive SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  }

  deleteArchive(id: string): void {
    this.db.query("DELETE FROM layer3_archive WHERE id = ?").run(id);
  }

  // ─── FTS5 Search (context + archive) ──────────────────────

  searchContext(query: string, limit = 10): FtsResult[] {
    const ftsQuery = sanitizeFtsQuery(query);
    if (!ftsQuery) return [];
    return this.db
      .query(
        "SELECT c.id, c.title, c.tags, snippet(fts_context, 1, '<b>', '</b>', '...', 32) AS snippet, rank, c.created_at, c.updated_at FROM fts_context f JOIN layer2_context c ON c.rowid = f.rowid WHERE fts_context MATCH ? ORDER BY rank LIMIT ?",
      )
      .all(ftsQuery, limit) as FtsResult[];
  }

  searchArchive(query: string, limit = 10): FtsResult[] {
    const ftsQuery = sanitizeFtsQuery(query);
    if (!ftsQuery) return [];
    return this.db
      .query(
        "SELECT a.id, a.title, a.tags, snippet(fts_archive, 1, '<b>', '</b>', '...', 32) AS snippet, rank, a.created_at, a.updated_at FROM fts_archive f JOIN layer3_archive a ON a.rowid = f.rowid WHERE fts_archive MATCH ? ORDER BY rank LIMIT ?",
      )
      .all(ftsQuery, limit) as FtsResult[];
  }
}
