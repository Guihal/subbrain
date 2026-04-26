import { Database } from "bun:sqlite";
import { sanitizeFtsQuery } from "../../lib/fts-utils";
import type {
  SharedRow,
  AgentMemRow,
  FtsResult,
  VecResult,
  MemoryStatus,
  MemoryKind,
} from "../types";
import { updateRow } from "./update-row";

// columns updatable from REST/UI
// MEM-5 (PR 22a): status joins the allow-list so the upcoming approval UI
// (PR 22b) can transition pending → active/rejected via updateShared.
// MEM-6 (mig 9): expires_at + superseded_by join the allow-list so the
// post-hippocampus + night cycle can write expiry/supersede markers via
// the same `updateRow` path the admin UI uses.
// M-07 (mig 12): `kind` joins so the post-hippocampus extractor can write
// the persona/semantic classification on a merge-update of an existing row.
// Trigger `trg_shared_kind_check_upd` enforces the closed enum at SQL level.
const SHARED_UPDATABLE = new Set([
  "content",
  "tags",
  "category",
  "status",
  "confidence",
  "expires_at",
  "superseded_by",
  "kind",
]);
const AGENT_MEM_UPDATABLE = new Set(["content", "tags"]);

// MEM-6: shared SQL fragment used by every read path that filters out
// expired/superseded rows. Lives here so the SQL stays in `tables/*` (per
// `tests/layer-boundary.test.ts`); call sites compose by string concat.
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

export interface InsertSharedOpts {
  confidence?: number | null;
  status?: MemoryStatus;
  // M-07 (mig 12): persona/semantic/episodic/procedural. Default 'semantic'
  // matches the SQL DEFAULT — callers pass 'persona' for identity facts via
  // `categoryToKind(category, 'shared')` in the post-hippocampus.
  kind?: MemoryKind;
}

export class SharedTable {
  constructor(public readonly db: Database) {}

  // ─── Shared Memory ─────────────────────────────────────────

  insertShared(
    id: string,
    category: string,
    content: string,
    tags: string = "",
    source?: string,
    opts?: InsertSharedOpts,
  ): void {
    const conf = opts?.confidence ?? null;
    const status = opts?.status ?? "active";
    const kind: MemoryKind = opts?.kind ?? "semantic";
    this.db
      .query(
        "INSERT INTO shared_memory (id, category, content, tags, source, confidence, status, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, category, content, tags, source ?? null, conf, status, kind);
  }

  getAllShared(): SharedRow[] {
    return this.db
      .query("SELECT * FROM shared_memory ORDER BY updated_at DESC")
      .all() as SharedRow[];
  }

  listShared(
    limit = 50,
    offset = 0,
    category?: string,
    kind?: MemoryKind,
  ): SharedRow[] {
    // M-07: optional `kind` filter (persona/semantic/episodic/procedural).
    // Composes with category — both clauses AND-joined when both supplied.
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
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    return this.db
      .query(
        `SELECT * FROM shared_memory ${whereSql} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as SharedRow[];
  }

  /**
   * MEM-6: list-with-fresh-filter helper. Used by admin `?active=true` only —
   * default admin path stays through `listShared` and continues to show every
   * row including expired/superseded for audit. Pagination + total are filtered
   * symmetrically so the UI doesn't show "1234 results" when only 5 are live.
   */
  listSharedActive(
    limit = 50,
    offset = 0,
    category?: string,
  ): { items: SharedRow[]; total: number } {
    const filter = buildActiveFilter("shared_memory", { activeOnly: true, notStale: true });
    const where = category
      ? `WHERE category = ? ${filter}`
      : `WHERE 1=1 ${filter}`;
    const params: (string | number)[] = category ? [category] : [];
    const items = this.db
      .query(`SELECT * FROM shared_memory ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as SharedRow[];
    const totalRow = this.db
      .query(`SELECT COUNT(*) AS c FROM shared_memory ${where}`)
      .get(...params) as { c: number };
    return { items, total: totalRow.c };
  }

  countShared(category?: string, kind?: MemoryKind): number {
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
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const row = this.db
      .query(`SELECT COUNT(*) AS c FROM shared_memory ${whereSql}`)
      .get(...params) as { c: number };
    return row.c;
  }

  getShared(id: string): SharedRow | null {
    return this.db.query("SELECT * FROM shared_memory WHERE id = ?").get(id) as SharedRow | null;
  }

  /**
   * Batch-lookup shared rows by id. `activeOnly` (PR 22a / MEM-5) filters out
   * pending/rejected rows. `notStale` (MEM-6, mig 9) filters out
   * superseded/expired rows. Both used by RAG injection so unapproved or
   * expired facts never reach model context. Filters compose AND-wise.
   */
  getSharedMany(
    ids: string[],
    opts?: { activeOnly?: boolean; notStale?: boolean },
  ): SharedRow[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    // alias `shared_memory` itself — no JOIN here, columns referenced bare.
    const filter = buildActiveFilter("shared_memory", opts);
    return this.db
      .query(
        `SELECT * FROM shared_memory WHERE id IN (${placeholders})${filter}`,
      )
      .all(...ids) as SharedRow[];
  }

  getSharedByCategory(category: string): SharedRow[] {
    return this.db
      .query("SELECT * FROM shared_memory WHERE category = ? ORDER BY updated_at DESC")
      .all(category) as SharedRow[];
  }

  updateShared(
    id: string,
    fields: {
      content?: string;
      tags?: string;
      category?: string;
      status?: MemoryStatus;
      confidence?: number | null;
      // MEM-6 (mig 9): post-hippocampus + night-cycle write paths.
      expires_at?: number | null;
      superseded_by?: string | null;
      // M-07 (mig 12): merge-update path in writeShared can re-classify
      // the row's kind when category changes. Closed enum enforced by
      // trigger `trg_shared_kind_check_upd`.
      kind?: MemoryKind;
    },
  ): void {
    updateRow(this.db, "shared_memory", SHARED_UPDATABLE, id, fields);
  }

  deleteShared(id: string): void {
    this.db.query("DELETE FROM shared_memory WHERE id = ?").run(id);
  }

  // ─── Agent Memory ──────────────────────────────────────────

  /**
   * Latest `agent_memory` row for an agentId (PR B-2). Used by
   * `agent-loop/persist.ts` to load the most recent dynamic-tool blob —
   * keeps SQL out of the pipeline.
   */
  getLatestAgentMemoryByAgentId(agentId: string): AgentMemRow | null {
    return this.db
      .query(
        "SELECT * FROM agent_memory WHERE agent_id = ? ORDER BY updated_at DESC LIMIT 1",
      )
      .get(agentId) as AgentMemRow | null;
  }

  /**
   * Update only `content` (and bump `updated_at`) on an existing
   * `agent_memory` row. Identity / tags untouched.
   */
  updateAgentMemoryContent(id: string, content: string): void {
    this.db
      .query(
        "UPDATE agent_memory SET content = ?, updated_at = unixepoch() WHERE id = ?",
      )
      .run(content, id);
  }

  insertAgentMemory(id: string, agentId: string, content: string, tags: string = ""): void {
    this.db
      .query("INSERT INTO agent_memory (id, agent_id, content, tags) VALUES (?, ?, ?, ?)")
      .run(id, agentId, content, tags);
  }

  getAgentMemories(agentId: string): AgentMemRow[] {
    return this.db
      .query("SELECT * FROM agent_memory WHERE agent_id = ? ORDER BY updated_at DESC")
      .all(agentId) as AgentMemRow[];
  }

  listAllAgentMemories(limit = 50, offset = 0, agentId?: string): AgentMemRow[] {
    if (agentId) {
      return this.db
        .query("SELECT * FROM agent_memory WHERE agent_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?")
        .all(agentId, limit, offset) as AgentMemRow[];
    }
    return this.db
      .query("SELECT * FROM agent_memory ORDER BY updated_at DESC LIMIT ? OFFSET ?")
      .all(limit, offset) as AgentMemRow[];
  }

  countAgentMemories(agentId?: string): number {
    if (agentId) {
      const row = this.db
        .query("SELECT COUNT(*) AS c FROM agent_memory WHERE agent_id = ?")
        .get(agentId) as { c: number };
      return row.c;
    }
    const row = this.db.query("SELECT COUNT(*) AS c FROM agent_memory").get() as { c: number };
    return row.c;
  }

  listAgentIds(): string[] {
    const rows = this.db
      .query("SELECT DISTINCT agent_id FROM agent_memory ORDER BY agent_id ASC")
      .all() as { agent_id: string }[];
    return rows.map((r) => r.agent_id);
  }

  getAgentMemory(id: string): AgentMemRow | null {
    return this.db.query("SELECT * FROM agent_memory WHERE id = ?").get(id) as AgentMemRow | null;
  }

  updateAgentMemory(id: string, fields: { content?: string; tags?: string }): void {
    updateRow(this.db, "agent_memory", AGENT_MEM_UPDATABLE, id, fields);
  }

  deleteAgentMemory(id: string): void {
    this.db.query("DELETE FROM agent_memory WHERE id = ?").run(id);
  }

  // ─── FTS5 Search (shared) ──────────────────────────────────

  /**
   * FTS5 search on shared_memory. `activeOnly` (PR 22a / MEM-5) filters by
   * status = 'active'. `notStale` (MEM-6, mig 9) filters out superseded /
   * expired rows. Both apply at JOIN-time on shared_memory; the FTS mirror
   * has no status/expires/superseded columns and is not rebuilt.
   *
   * B-1 note: shared_memory has no `agent_id` column (see schema.ts). The
   * table is by-design global — accepted writers (post-hippocampus
   * `writeShared`, context-compressor) intentionally publish facts visible
   * to every agent. Per-agent privacy lives in the separate `agent_memory`
   * table (`getAgentMemories` filter). Adding agent isolation here would
   * require schema work + writer updates and is out of scope.
   */
  searchShared(
    query: string,
    limit = 10,
    opts?: { activeOnly?: boolean; notStale?: boolean },
  ): FtsResult[] {
    const ftsQuery = sanitizeFtsQuery(query);
    if (!ftsQuery) return [];
    const filter = buildActiveFilter("s", opts);
    // M-07: SELECT `s.kind` so RAG can apply the persona boost without an
    // extra round-trip. Other FtsResult consumers ignore the field.
    // M-03 (mig 13): SELECT `s.salience` so the RAG salience-boost step
    // does not need an extra round-trip per hit.
    // M-08: SELECT `s.last_accessed_at, s.access_count` so the forgetting
    // curve step (`lib/memory-decay.ts:applyForgettingCurve`) reads them
    // without a second round-trip per hit.
    return this.db
      .query(
        `SELECT s.id, s.category AS title, s.tags, snippet(fts_shared, 1, '<b>', '</b>', '...', 32) AS snippet, rank, s.created_at, s.updated_at, s.kind, s.salience, s.last_accessed_at, s.access_count FROM fts_shared f JOIN shared_memory s ON s.rowid = f.rowid WHERE fts_shared MATCH ?${filter} ORDER BY rank LIMIT ?`,
      )
      .all(ftsQuery, limit) as FtsResult[];
  }

  // ─── Vector Search (sqlite-vec) ────────────────────────────

  upsertEmbedding(id: string, layer: string, embedding: Float32Array): void {
    this.db
      .query("INSERT OR REPLACE INTO vec_embeddings (id, layer, embedding) VALUES (?, ?, ?)")
      .run(id, layer, new Uint8Array(embedding.buffer));
  }

  searchEmbeddings(embedding: Float32Array, limit = 10, layer?: string): VecResult[] {
    const blob = new Uint8Array(embedding.buffer);
    if (layer) {
      return this.db
        .query(
          "SELECT id, layer, distance FROM vec_embeddings WHERE embedding MATCH ? AND layer = ? ORDER BY distance LIMIT ?",
        )
        .all(blob, layer, limit) as VecResult[];
    }
    return this.db
      .query("SELECT id, layer, distance FROM vec_embeddings WHERE embedding MATCH ? ORDER BY distance LIMIT ?")
      .all(blob, limit) as VecResult[];
  }

  deleteEmbedding(id: string): void {
    this.db.query("DELETE FROM vec_embeddings WHERE id = ?").run(id);
  }

  /**
   * M-09: most-recent active+fresh shared rows for cross-layer dedup. Returns
   * `cat = lower(category)` so the caller can match against context.title /
   * archive.title without a second pass.
   */
  recentActiveSharedForCrossLayer(limit: number): { id: string; cat: string; updated_at: number }[] {
    return this.db
      .query<{ id: string; cat: string; updated_at: number }, [number]>(
        "SELECT id, lower(category) AS cat, updated_at FROM shared_memory WHERE status='active' AND superseded_by IS NULL AND (expires_at IS NULL OR expires_at > unixepoch()) ORDER BY updated_at DESC LIMIT ?",
      )
      .all(limit);
  }

  /**
   * M-09: bulk-fetch raw embedding vectors for given ids in a layer. Used by
   * the cross-layer dedup step to compute cosine in JS (sqlite-vec returns L2
   * on un-normalised vectors per audit). Empty ids → empty Map. Callers cap
   * `ids.length` (CROSS_LAYER_DEDUP_LIMIT) so the IN(?,?,…) clause stays
   * SQLite-friendly. Missing ids are simply absent from the returned Map.
   */
  getEmbeddingsByIds(layer: string, ids: string[]): Map<string, Float32Array> {
    const out = new Map<string, Float32Array>();
    if (ids.length === 0) return out;
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .query(
        `SELECT id, embedding FROM vec_embeddings WHERE layer = ? AND id IN (${placeholders})`,
      )
      .all(layer, ...ids) as { id: string; embedding: Uint8Array }[];
    for (const r of rows) {
      const blob = r.embedding;
      if (!blob || blob.byteLength % 4 !== 0) continue;
      out.set(
        r.id,
        new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4),
      );
    }
    return out;
  }
}
