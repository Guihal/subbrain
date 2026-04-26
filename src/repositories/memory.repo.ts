/**
 * MemoryRepository — PR 27 (LAYER-5).
 *
 * Owns Layer-1/2/3 memory tables + shared + agent + embeddings. Sits between
 * services (which now never see raw SQL) and the per-table classes in
 * `src/db/tables/*`. `MemoryDB` (thin facade) delegates its memory methods
 * into here too — back-compat for scripts/seed.ts, audit-db.ts, and tests
 * that still hold a `MemoryDB` handle.
 *
 * Boundary rule: raw SQL stays in `src/db/tables/*` and here (via table-class
 * calls + `db.transaction`). Services / routes / pipeline must not issue SQL
 * directly — enforced by `tests/layer-boundary.test.ts`.
 *
 * Cross-layer ops (shared+embedding, context+embedding) are exposed as
 * `insertSharedWithEmbedding` / `insertContextWithEmbedding` so callers
 * get atomicity via `this.transaction()`.
 */
import { Database } from "bun:sqlite";
import { MemoryTable, type InsertContextOpts } from "../db/tables/memory";
import { SharedTable, type InsertSharedOpts } from "../db/tables/shared";
import type {
  ContextRow,
  ArchiveRow,
  SharedRow,
  AgentMemRow,
  FtsResult,
  VecResult,
  MemoryStatus,
  MemoryKind,
} from "../db/types";

type PendingLayer = "shared" | "context";

export class MemoryRepository {
  private readonly mem: MemoryTable;
  private readonly shared: SharedTable;

  constructor(private readonly db: Database) {
    this.mem = new MemoryTable(db);
    this.shared = new SharedTable(db);
  }

  /** Escape hatch for transactional composition (embed+insert atomicity). */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ─── Layer 1: Focus ────────────────────────────────────────
  getFocus = (key: string) => this.mem.getFocus(key);
  setFocus = (key: string, value: string) => this.mem.setFocus(key, value);
  getAllFocus = () => this.mem.getAllFocus();
  deleteFocus = (key: string) => this.mem.deleteFocus(key);

  // ─── Layer 2: Context ──────────────────────────────────────
  insertContext = (
    id: string,
    title: string,
    content: string,
    tags?: string,
    derivedFrom?: string[],
    agentId?: string,
    opts?: InsertContextOpts,
  ) => this.mem.insertContext(id, title, content, tags, derivedFrom, agentId, opts);
  updateContext = (
    id: string,
    fields: {
      title?: string;
      content?: string;
      tags?: string;
      status?: MemoryStatus;
      confidence?: number | null;
      // MEM-6: post-hippocampus + night-cycle write paths.
      expires_at?: number | null;
      superseded_by?: string | null;
      derived_from?: string;
    },
  ) => this.mem.updateContext(id, fields);
  getContext = (id: string) => this.mem.getContext(id);
  getContextMany = (
    ids: string[],
    opts?: { activeOnly?: boolean; notStale?: boolean; agentId?: string },
  ) => this.mem.getContextMany(ids, opts);
  listContext = (limit?: number, offset?: number) => this.mem.listContext(limit, offset);
  listContextActive = (limit?: number, offset?: number) =>
    this.mem.listContextActive(limit, offset);
  countContext = () => this.mem.countContext();
  deleteContext = (id: string) => this.mem.deleteContext(id);

  // ─── Layer 3: Archive ──────────────────────────────────────
  insertArchive = (
    id: string,
    title: string,
    content: string,
    tags?: string,
    sourceRequestIds?: string[],
    confidence?: "HIGH" | "LOW",
    agentId?: string,
  ) => this.mem.insertArchive(id, title, content, tags, sourceRequestIds, confidence, agentId);
  getArchive = (id: string) => this.mem.getArchive(id);
  getArchiveMany = (ids: string[]) => this.mem.getArchiveMany(ids);
  listArchive = (limit?: number, offset?: number) => this.mem.listArchive(limit, offset);
  countArchive = () => this.mem.countArchive();
  updateArchive = (
    id: string,
    fields: { title?: string; content?: string; tags?: string; confidence?: "HIGH" | "LOW" },
  ) => this.mem.updateArchive(id, fields);
  deleteArchive = (id: string) => this.mem.deleteArchive(id);

  // ─── FTS5 Search (context + archive) ──────────────────────
  searchContext = (
    query: string,
    limit?: number,
    opts?: { activeOnly?: boolean; notStale?: boolean; agentId?: string },
  ): FtsResult[] => this.mem.searchContext(query, limit, opts);
  searchArchive = (query: string, limit?: number): FtsResult[] =>
    this.mem.searchArchive(query, limit);

  // M-06: see MemoryTable.reflectGroups doc-comment.
  reflectGroups = (
    whitelist: readonly string[],
    minAccess: number,
    minGroup: number,
    maxGroups: number,
  ) => this.mem.reflectGroups(whitelist, minAccess, minGroup, maxGroups);

  // ─── Shared Memory ─────────────────────────────────────────
  insertShared = (
    id: string,
    category: string,
    content: string,
    tags?: string,
    source?: string,
    opts?: InsertSharedOpts,
  ) => this.shared.insertShared(id, category, content, tags, source, opts);
  getAllShared = (): SharedRow[] => this.shared.getAllShared();
  listShared = (
    limit?: number,
    offset?: number,
    category?: string,
    kind?: MemoryKind,
  ) => this.shared.listShared(limit, offset, category, kind);
  listSharedActive = (limit?: number, offset?: number, category?: string) =>
    this.shared.listSharedActive(limit, offset, category);
  countShared = (category?: string, kind?: MemoryKind) =>
    this.shared.countShared(category, kind);
  getShared = (id: string) => this.shared.getShared(id);
  getSharedMany = (
    ids: string[],
    opts?: { activeOnly?: boolean; notStale?: boolean },
  ) => this.shared.getSharedMany(ids, opts);
  getSharedByCategory = (category: string) => this.shared.getSharedByCategory(category);
  updateShared = (
    id: string,
    fields: {
      content?: string;
      tags?: string;
      category?: string;
      status?: MemoryStatus;
      confidence?: number | null;
      // MEM-6: post-hippocampus + night-cycle write paths.
      expires_at?: number | null;
      superseded_by?: string | null;
      // M-07: persona/semantic re-classification on merge-update.
      kind?: MemoryKind;
    },
  ) => this.shared.updateShared(id, fields);
  deleteShared = (id: string) => this.shared.deleteShared(id);

  // ─── Agent Memory ──────────────────────────────────────────
  insertAgentMemory = (id: string, agentId: string, content: string, tags?: string) =>
    this.shared.insertAgentMemory(id, agentId, content, tags);
  getAgentMemories = (agentId: string): AgentMemRow[] => this.shared.getAgentMemories(agentId);
  /** PR B-2: lift `agent-loop/persist.ts` raw SQL out of the pipeline. */
  getLatestAgentMemoryByAgentId = (agentId: string): AgentMemRow | null =>
    this.shared.getLatestAgentMemoryByAgentId(agentId);
  updateAgentMemoryContent = (id: string, content: string) =>
    this.shared.updateAgentMemoryContent(id, content);
  listAllAgentMemories = (limit?: number, offset?: number, agentId?: string) =>
    this.shared.listAllAgentMemories(limit, offset, agentId);
  countAgentMemories = (agentId?: string) => this.shared.countAgentMemories(agentId);
  listAgentIds = (): string[] => this.shared.listAgentIds();
  getAgentMemory = (id: string) => this.shared.getAgentMemory(id);
  updateAgentMemory = (id: string, fields: { content?: string; tags?: string }) =>
    this.shared.updateAgentMemory(id, fields);
  deleteAgentMemory = (id: string) => this.shared.deleteAgentMemory(id);

  // ─── FTS5 + Vector (shared + embeddings) ──────────────────
  searchShared = (
    query: string,
    limit?: number,
    opts?: { activeOnly?: boolean; notStale?: boolean },
  ): FtsResult[] => this.shared.searchShared(query, limit, opts);
  upsertEmbedding = (id: string, layer: string, embedding: Float32Array) =>
    this.shared.upsertEmbedding(id, layer, embedding);
  searchEmbeddings = (embedding: Float32Array, limit?: number, layer?: string): VecResult[] =>
    this.shared.searchEmbeddings(embedding, limit, layer);
  deleteEmbedding = (id: string) => this.shared.deleteEmbedding(id);

  // ─── MEM-6 supersede helper ─────────────────────────────────
  /**
   * Mark a row as superseded. `by` is one of:
   *   - a UUID-shaped row id (the row that replaces this one), OR
   *   - the literal string 'expired' (used by the night-cycle expiry pass).
   *
   * Sentinel + row-id share one column intentionally — collision is
   * impossible because randomUUID() never produces the literal "expired".
   * Wraps `updateShared` / `updateContext` so SQL stays in `tables/*`
   * (boundary test stays green). Caller validates that a row id `by` exists;
   * the BEFORE-UPDATE trigger only blocks self-supersede (id == NEW.superseded_by).
   */
  setSupersededBy(layer: "shared" | "context", id: string, by: string): void {
    if (layer === "shared") this.shared.updateShared(id, { superseded_by: by });
    else this.mem.updateContext(id, { superseded_by: by });
  }

  // ─── M-02: access tracking (mig 10) ───────────────────────
  /**
   * Bump `last_accessed_at` and `access_count` for a batch of rows in a
   * single layer. Called by RAG retrieval after rerank so popularity-
   * based signals (M-03 salience, M-08 Ebbinghaus decay) have data to
   * work with. Single UPDATE — SQLite makes single-statement writes
   * atomic, so no transaction wrapper needed.
   *
   * Empty `ids` is an early-return (SQLite rejects an empty `IN ()`
   * clause at parse time). `layer` is a closed union — table name comes
   * from a switch, no injection surface.
   *
   * Field names are intentionally `last_accessed_at` and `access_count`
   * (not abbreviated) to match the migration column names exactly.
   */
  bumpAccess(layer: "shared" | "context" | "archive", ids: string[]): void {
    if (ids.length === 0) return;
    const table =
      layer === "shared"
        ? "shared_memory"
        : layer === "context"
        ? "layer2_context"
        : "layer3_archive";
    const placeholders = ids.map(() => "?").join(",");
    // unix-seconds — matches the rest of the schema (created_at/updated_at/
    // expires_at all use unixepoch()). M-08 Ebbinghaus decay computes
    // (now - last_accessed_at) and would silently 1000× over-age if we
    // wrote ms here.
    const now = Math.floor(Date.now() / 1000);
    // M-03 (mig 13): reinforce salience on every hit.
    //   bonus = 0.05 * exp(-age_days / 7), age_days = (now - prev_last_accessed)/86400
    // First-ever hit (last_accessed_at IS NULL) → COALESCE proxies to `now` →
    // age_days = 0 → bonus = 0.05 (full). Older rows get exponentially
    // smaller bonuses. Cap at 1.0 via MIN(1.0, ...). bun:sqlite ships EXP()
    // (verified via `SELECT EXP(0)`) — no piecewise CASE fallback needed.
    this.db
      .query(
        `UPDATE ${table}
            SET last_accessed_at = ?,
                access_count = access_count + 1,
                salience = MIN(
                  1.0,
                  salience + 0.05 * EXP(
                    -CAST(? - COALESCE(last_accessed_at, ?) AS REAL) / (7.0 * 86400.0)
                  )
                )
          WHERE id IN (${placeholders})`,
      )
      .run(now, now, now, ...ids);
  }

  // ─── M-03: night-cycle salience decay (mig 13) ────────────
  /**
   * Multiply `salience` by `0.98 ^ days_since_last_decayed` for every row in
   * a layer that has ever been accessed. Uses POW() (verified to be
   * available in bun:sqlite via `SELECT POW(2,3)`). Returns the number of
   * rows affected.
   *
   * Idempotency: when `last_decayed_at` is set, age = (now - last_decayed)
   * → re-running on the same day is a no-op (multiplier = 1). On the
   * very first run after migration `last_decayed_at IS NULL`; we proxy to
   * `last_accessed_at` so the first decay still gets a sensible age.
   * Rows that were never accessed (both columns NULL) are filtered out.
   *
   * Floor: rows with `salience <= 0.001` are skipped. Avoids epsilon
   * multiplication noise on already-cold rows + saves writes.
   *
   * `now` is supplied by the caller so a single night-cycle pass uses one
   * consistent timestamp across all 3 layers.
   */
  decaySalience(layer: "shared" | "context" | "archive", now: number): number {
    const table =
      layer === "shared"
        ? "shared_memory"
        : layer === "context"
        ? "layer2_context"
        : "layer3_archive";
    // MAX(0, ...) clamps a future last_decayed_at (clock skew) so salience
    // never inflates from a negative age.
    const result = this.db
      .query(
        `UPDATE ${table}
            SET salience = salience * POW(
                  0.98,
                  MAX(
                    0.0,
                    CAST(? - COALESCE(last_decayed_at, last_accessed_at) AS REAL) / 86400.0
                  )
                ),
                last_decayed_at = ?
          WHERE COALESCE(last_decayed_at, last_accessed_at) IS NOT NULL
            AND salience > 0.001`,
      )
      .run(now, now);
    return result.changes;
  }

  // ─── Pending (status-filtered) list (PR 22a / MEM-5) ──────
  /**
   * Previously lived in `MemoryService.listByStatus` (raw SQL leak that
   * boundary-test now blocks). Folded back to the repo layer where it
   * belongs. Table comes from a 2-value union — no injection surface.
   */
  listByStatus(
    layer: PendingLayer,
    status: MemoryStatus,
    limit: number,
    offset: number,
  ): { items: (SharedRow | ContextRow)[]; total: number } {
    const table = layer === "shared" ? "shared_memory" : "layer2_context";
    const items = this.db
      .query(`SELECT * FROM ${table} WHERE status = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
      .all(status, limit, offset) as (SharedRow | ContextRow)[];
    const row = this.db
      .query(`SELECT COUNT(*) AS c FROM ${table} WHERE status = ?`)
      .get(status) as { c: number };
    return { items, total: row.c };
  }

  // Single source of truth for pending-approval status flips (PR 22b).
  // 404-semantics live here: `null` → caller throws NotFoundError.
  // `bun:sqlite` single-conn serializes the BEGIN..COMMIT so mid-tx delete is
  // physically impossible under the default runtime config.
  setStatusSafe(
    layer: PendingLayer,
    id: string,
    status: MemoryStatus,
  ): SharedRow | ContextRow | null {
    return this.transaction(() => {
      if (layer === "shared") {
        if (!this.getShared(id)) return null;
        this.updateShared(id, { status });
        return this.getShared(id);
      }
      if (!this.getContext(id)) return null;
      this.updateContext(id, { status });
      return this.getContext(id);
    });
  }
}
