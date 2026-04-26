import { Database } from "bun:sqlite";
import { sanitizeFtsQuery } from "../../lib/fts-utils";
import type { ContextRow, ArchiveRow, FtsResult, MemoryStatus } from "../types";
import { updateRow } from "./update-row";

// columns updatable from REST/UI
// MEM-5 (PR 22a): status joins the allow-list so the approval UI (PR 22b)
// can transition pending → active/rejected via updateContext.
// MEM-6 (mig 9): expires_at + superseded_by join the allow-list — same
// rationale as shared_memory (post-hippocampus + night-cycle write paths).
const CONTEXT_UPDATABLE = new Set([
  "title",
  "content",
  "tags",
  "status",
  "confidence",
  "expires_at",
  "superseded_by",
  "derived_from",
]);
const ARCHIVE_UPDATABLE = new Set(["title", "content", "tags", "confidence"]);

// MEM-6: same shape as shared.ts:buildActiveFilter — kept inline here so
// each table file owns its own SQL (boundary test forbids services hitting
// SQL directly, but tables/* are the system-of-record).
function buildActiveFilter(
  alias: string,
  opts: { activeOnly?: boolean; notStale?: boolean } | undefined,
): string {
  const parts: string[] = [];
  if (opts?.activeOnly) parts.push(`AND ${alias}.status = 'active'`);
  if (opts?.notStale) {
    parts.push(`AND ${alias}.superseded_by IS NULL`);
    parts.push(
      `AND (${alias}.expires_at IS NULL OR ${alias}.expires_at > unixepoch())`,
    );
  }
  return parts.length === 0 ? "" : ` ${parts.join(" ")}`;
}

export interface InsertContextOpts {
  confidence?: number | null;
  status?: MemoryStatus;
}

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
    opts?: InsertContextOpts,
  ): void {
    const conf = opts?.confidence ?? null;
    const status = opts?.status ?? "active";
    this.db
      .query(
        "INSERT INTO layer2_context (id, title, content, tags, derived_from, agent_id, confidence, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        title,
        content,
        tags,
        JSON.stringify(derivedFrom),
        agentId ?? null,
        conf,
        status,
      );
  }

  updateContext(
    id: string,
    fields: {
      title?: string;
      content?: string;
      tags?: string;
      status?: MemoryStatus;
      confidence?: number | null;
      // MEM-6 (mig 9): post-hippocampus + night-cycle write paths.
      expires_at?: number | null;
      superseded_by?: string | null;
      derived_from?: string;
    },
  ): void {
    updateRow(this.db, "layer2_context", CONTEXT_UPDATABLE, id, fields);
  }

  getContext(id: string): ContextRow | null {
    return this.db
      .query("SELECT * FROM layer2_context WHERE id = ?")
      .get(id) as ContextRow | null;
  }

  /**
   * Batch-lookup context rows by id. `activeOnly` (PR 22a / MEM-5) filters out
   * pending/rejected rows. `notStale` (MEM-6, mig 9) filters out superseded /
   * expired rows. `agentId` (B-1) restricts to the caller's own private rows
   * + global (NULL) rows; absent → no agent filter (admin scope).
   */
  getContextMany(
    ids: string[],
    opts?: { activeOnly?: boolean; notStale?: boolean; agentId?: string },
  ): ContextRow[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const filter = buildActiveFilter("layer2_context", opts);
    const agentFilter = opts?.agentId ? " AND (agent_id = ? OR agent_id IS NULL)" : "";
    const params: (string | number)[] = [...ids];
    if (opts?.agentId) params.push(opts.agentId);
    return this.db
      .query(
        `SELECT * FROM layer2_context WHERE id IN (${placeholders})${filter}${agentFilter}`,
      )
      .all(...params) as ContextRow[];
  }

  listContext(limit = 50, offset = 0): ContextRow[] {
    return this.db
      .query("SELECT * FROM layer2_context ORDER BY updated_at DESC LIMIT ? OFFSET ?")
      .all(limit, offset) as ContextRow[];
  }

  /**
   * MEM-6: list-with-fresh-filter helper for admin `?active=true`.
   * See shared.ts:listSharedActive for the rationale.
   */
  listContextActive(
    limit = 50,
    offset = 0,
  ): { items: ContextRow[]; total: number } {
    const filter = buildActiveFilter("layer2_context", { activeOnly: true, notStale: true });
    const items = this.db
      .query(`SELECT * FROM layer2_context WHERE 1=1 ${filter} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
      .all(limit, offset) as ContextRow[];
    const totalRow = this.db
      .query(`SELECT COUNT(*) AS c FROM layer2_context WHERE 1=1 ${filter}`)
      .get() as { c: number };
    return { items, total: totalRow.c };
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

  getArchiveMany(ids: string[]): ArchiveRow[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    return this.db
      .query(`SELECT * FROM layer3_archive WHERE id IN (${placeholders})`)
      .all(...ids) as ArchiveRow[];
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
    updateRow(this.db, "layer3_archive", ARCHIVE_UPDATABLE, id, fields);
  }

  deleteArchive(id: string): void {
    this.db.query("DELETE FROM layer3_archive WHERE id = ?").run(id);
  }

  // ─── FTS5 Search (context + archive) ──────────────────────

  /**
   * FTS5 search on layer2_context. `activeOnly` (PR 22a / MEM-5) filters by
   * status = 'active'. `notStale` (MEM-6, mig 9) filters superseded/expired
   * rows. `agentId` (B-1) restricts to caller's own private rows + global
   * (NULL) rows; absent → no agent filter (admin scope). Pre-B-1 rows stored
   * without agent_id are NULL → visible to any caller (legacy "shared"
   * back-compat; see B-1 leak-window note in docs/02-audit.md).
   */
  searchContext(
    query: string,
    limit = 10,
    opts?: { activeOnly?: boolean; notStale?: boolean; agentId?: string },
  ): FtsResult[] {
    const ftsQuery = sanitizeFtsQuery(query);
    if (!ftsQuery) return [];
    const filter = buildActiveFilter("c", opts);
    const agentFilter = opts?.agentId ? " AND (c.agent_id = ? OR c.agent_id IS NULL)" : "";
    const params: (string | number)[] = [ftsQuery];
    if (opts?.agentId) params.push(opts.agentId);
    params.push(limit);
    // M-03 (mig 13): SELECT `c.salience` for the RAG salience-boost step.
    return this.db
      .query(
        `SELECT c.id, c.title, c.tags, snippet(fts_context, 1, '<b>', '</b>', '...', 32) AS snippet, rank, c.created_at, c.updated_at, c.salience FROM fts_context f JOIN layer2_context c ON c.rowid = f.rowid WHERE fts_context MATCH ?${filter}${agentFilter} ORDER BY rank LIMIT ?`,
      )
      .all(...params) as FtsResult[];
  }

  searchArchive(query: string, limit = 10): FtsResult[] {
    const ftsQuery = sanitizeFtsQuery(query);
    if (!ftsQuery) return [];
    // M-03 (mig 13): SELECT `a.salience` for the RAG salience-boost step.
    return this.db
      .query(
        "SELECT a.id, a.title, a.tags, snippet(fts_archive, 1, '<b>', '</b>', '...', 32) AS snippet, rank, a.created_at, a.updated_at, a.salience FROM fts_archive f JOIN layer3_archive a ON a.rowid = f.rowid WHERE fts_archive MATCH ? ORDER BY rank LIMIT ?",
      )
      .all(ftsQuery, limit) as FtsResult[];
  }
}
