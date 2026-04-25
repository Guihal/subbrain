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
    },
  ) => this.mem.updateContext(id, fields);
  getContext = (id: string) => this.mem.getContext(id);
  getContextMany = (
    ids: string[],
    opts?: { activeOnly?: boolean; agentId?: string },
  ) => this.mem.getContextMany(ids, opts);
  listContext = (limit?: number, offset?: number) => this.mem.listContext(limit, offset);
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
    opts?: { activeOnly?: boolean; agentId?: string },
  ): FtsResult[] => this.mem.searchContext(query, limit, opts);
  searchArchive = (query: string, limit?: number): FtsResult[] =>
    this.mem.searchArchive(query, limit);

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
  listShared = (limit?: number, offset?: number, category?: string) =>
    this.shared.listShared(limit, offset, category);
  countShared = (category?: string) => this.shared.countShared(category);
  getShared = (id: string) => this.shared.getShared(id);
  getSharedMany = (ids: string[], opts?: { activeOnly?: boolean }) =>
    this.shared.getSharedMany(ids, opts);
  getSharedByCategory = (category: string) => this.shared.getSharedByCategory(category);
  updateShared = (
    id: string,
    fields: {
      content?: string;
      tags?: string;
      category?: string;
      status?: MemoryStatus;
      confidence?: number | null;
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
  searchShared = (query: string, limit?: number, opts?: { activeOnly?: boolean }): FtsResult[] =>
    this.shared.searchShared(query, limit, opts);
  upsertEmbedding = (id: string, layer: string, embedding: Float32Array) =>
    this.shared.upsertEmbedding(id, layer, embedding);
  searchEmbeddings = (embedding: Float32Array, limit?: number, layer?: string): VecResult[] =>
    this.shared.searchEmbeddings(embedding, limit, layer);
  deleteEmbedding = (id: string) => this.shared.deleteEmbedding(id);

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
