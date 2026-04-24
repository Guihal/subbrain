/**
 * MemoryService — PR 25b (LAYER-2). Single home for every `MemoryDB` call
 * the HTTP memory surface used to do inline. Route now thin (TypeBox +
 * `paginate()` envelope); this service owns embed+transaction atomicity,
 * status filters, pending queries.
 *
 * Conventions (.claude/skills/subbrain-guardrails/SKILL.md):
 *   - List methods return `{items,total}` → route wraps in `paginate` (§8).
 *   - Mutations through table-class helpers backed by `updateRow` (§4).
 *   - Inserts: embed-first then one `db.transaction()`, mirroring
 *     `post/extractors.ts:writeShared` so a failed embed never orphans a row
 *     without a vector (§4).
 *   - FTS via `MemoryDB.search*` (which calls `sanitizeFtsQuery` internally,
 *     §4); service does not re-sanitize.
 */
import { randomUUID } from "crypto";
import type {
  MemoryDB,
  SharedRow,
  ContextRow,
  ArchiveRow,
  AgentMemRow,
  LogRow,
  MemoryStatus,
} from "../db";
import type { RAGPipeline } from "../rag";

const EMBED_TIMEOUT_MS = 5000;

export interface PaginatedResult<T> {
  items: T[];
  total: number;
}

export type ListOpts = {
  limit: number;
  offset: number;
  q?: string;
  status?: MemoryStatus;
  category?: string;
  agentId?: string;
  sessionId?: string;
};

export type InsertSharedInput = {
  category: string;
  content: string;
  tags?: string;
  source?: string;
  confidence?: number | null;
  status?: MemoryStatus;
};

export type InsertContextInput = {
  title: string;
  content: string;
  tags?: string;
  derivedFrom?: string[];
  agentId?: string;
  confidence?: number | null;
  status?: MemoryStatus;
};

export type UpdateSharedPatch = {
  content?: string;
  tags?: string;
  category?: string;
  status?: MemoryStatus;
  confidence?: number | null;
};
export type UpdateContextPatch = {
  title?: string;
  content?: string;
  tags?: string;
  status?: MemoryStatus;
  confidence?: number | null;
};
export type UpdateArchivePatch = {
  title?: string;
  content?: string;
  tags?: string;
  confidence?: "HIGH" | "LOW";
};
export type UpdateAgentPatch = { content?: string; tags?: string };

type PendingLayer = "shared" | "context";

async function embedWithTimeout(rag: RAGPipeline, content: string): Promise<Float32Array> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      rag.embedContent(content),
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error("embed_timeout")), EMBED_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class MemoryService {
  constructor(private readonly mem: MemoryDB, private readonly rag: RAGPipeline) {}

  // ─── Focus (L1, KV) ───────────────────────────────────────
  listFocus(): Record<string, string> { return this.mem.getAllFocus(); }
  upsertFocus(key: string, value: string): void { this.mem.setFocus(key, value); }
  deleteFocus(key: string): void { this.mem.deleteFocus(key); }

  // ─── Shared ───────────────────────────────────────────────
  listShared(opts: ListOpts): PaginatedResult<SharedRow> {
    if (opts.q) {
      const hits = this.mem.searchShared(opts.q, opts.limit);
      const items = hits.map((h) => this.mem.getShared(h.id)).filter((r): r is SharedRow => r !== null);
      return { items, total: items.length };
    }
    if (opts.status) return this.listByStatus("shared", opts.status, opts.limit, opts.offset) as PaginatedResult<SharedRow>;
    return {
      items: this.mem.listShared(opts.limit, opts.offset, opts.category),
      total: this.mem.countShared(opts.category),
    };
  }
  getShared(id: string): SharedRow | null { return this.mem.getShared(id); }

  /** Embed-first then transactional insert+upsertEmbedding (§4). */
  async insertShared(input: InsertSharedInput): Promise<string> {
    const id = randomUUID();
    const vec = await embedWithTimeout(this.rag, input.content);
    if (!vec || vec.length === 0) throw new Error("embed_empty");
    this.mem.db.transaction(() => {
      this.mem.insertShared(
        id, input.category, input.content, input.tags ?? "", input.source,
        { confidence: input.confidence ?? null, status: input.status },
      );
      this.mem.upsertEmbedding(id, "shared", vec);
    })();
    return id;
  }
  patchShared(id: string, patch: UpdateSharedPatch): SharedRow | null {
    this.mem.updateShared(id, patch);
    return this.mem.getShared(id);
  }
  deleteShared(id: string): void { this.mem.deleteShared(id); }

  // ─── Context (L2) ─────────────────────────────────────────
  listContext(opts: ListOpts): PaginatedResult<ContextRow> {
    if (opts.q) {
      const hits = this.mem.searchContext(opts.q, opts.limit);
      const items = hits.map((h) => this.mem.getContext(h.id)).filter((r): r is ContextRow => r !== null);
      return { items, total: items.length };
    }
    if (opts.status) return this.listByStatus("context", opts.status, opts.limit, opts.offset) as PaginatedResult<ContextRow>;
    return { items: this.mem.listContext(opts.limit, opts.offset), total: this.mem.countContext() };
  }
  getContext(id: string): ContextRow | null { return this.mem.getContext(id); }

  async insertContext(input: InsertContextInput): Promise<string> {
    const id = randomUUID();
    const vec = await embedWithTimeout(this.rag, input.content);
    if (!vec || vec.length === 0) throw new Error("embed_empty");
    this.mem.db.transaction(() => {
      this.mem.insertContext(
        id, input.title, input.content, input.tags ?? "", input.derivedFrom ?? [], input.agentId,
        { confidence: input.confidence ?? null, status: input.status },
      );
      this.mem.upsertEmbedding(id, "context", vec);
    })();
    return id;
  }
  patchContext(id: string, patch: UpdateContextPatch): ContextRow | null {
    this.mem.updateContext(id, patch);
    return this.mem.getContext(id);
  }
  deleteContext(id: string): void { this.mem.deleteContext(id); }

  // ─── Archive (L3) ─────────────────────────────────────────
  listArchive(opts: ListOpts): PaginatedResult<ArchiveRow> {
    if (opts.q) {
      const hits = this.mem.searchArchive(opts.q, opts.limit);
      const items = hits.map((h) => this.mem.getArchive(h.id)).filter((r): r is ArchiveRow => r !== null);
      return { items, total: items.length };
    }
    return { items: this.mem.listArchive(opts.limit, opts.offset), total: this.mem.countArchive() };
  }
  getArchive(id: string): ArchiveRow | null { return this.mem.getArchive(id); }
  patchArchive(id: string, patch: UpdateArchivePatch): ArchiveRow | null {
    this.mem.updateArchive(id, patch);
    return this.mem.getArchive(id);
  }
  deleteArchive(id: string): void { this.mem.deleteArchive(id); }

  // ─── Agent memory ─────────────────────────────────────────
  listAgentIds(): string[] { return this.mem.listAgentIds(); }
  listAgent(opts: ListOpts): PaginatedResult<AgentMemRow> {
    return {
      items: this.mem.listAllAgentMemories(opts.limit, opts.offset, opts.agentId),
      total: this.mem.countAgentMemories(opts.agentId),
    };
  }
  getAgent(id: string): AgentMemRow | null { return this.mem.getAgentMemory(id); }
  patchAgent(id: string, patch: UpdateAgentPatch): AgentMemRow | null {
    this.mem.updateAgentMemory(id, patch);
    return this.mem.getAgentMemory(id);
  }
  deleteAgent(id: string): void { this.mem.deleteAgentMemory(id); }

  // ─── Log (L4, read-only) ──────────────────────────────────
  listLog(opts: ListOpts): PaginatedResult<LogRow> {
    return {
      items: this.mem.listLog(opts.limit, opts.offset, opts.sessionId),
      total: this.mem.countLog(opts.sessionId),
    };
  }
  listLogSessions(limit = 50): ReturnType<MemoryDB["listLogSessions"]> {
    return this.mem.listLogSessions(limit);
  }

  // ─── Pending / status (22b compat) ────────────────────────
  listPending(layer: PendingLayer, opts: { limit: number; offset: number }): PaginatedResult<SharedRow | ContextRow> {
    return this.listByStatus(layer, "pending", opts.limit, opts.offset);
  }
  setStatus(layer: PendingLayer, id: string, status: MemoryStatus): void {
    if (layer === "shared") this.mem.updateShared(id, { status });
    else this.mem.updateContext(id, { status });
  }

  /**
   * Sole place talking to `MemoryDB.db` directly. Tables don't expose
   * listByStatus, and 25b scope forbids growing them. Parameterized SQL,
   * table from a 2-value union → no injection surface. PR 27 (Repository)
   * will fold this back into a table helper.
   */
  private listByStatus(
    layer: PendingLayer,
    status: MemoryStatus,
    limit: number,
    offset: number,
  ): PaginatedResult<SharedRow | ContextRow> {
    const table = layer === "shared" ? "shared_memory" : "layer2_context";
    const items = this.mem.db
      .query(`SELECT * FROM ${table} WHERE status = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
      .all(status, limit, offset) as (SharedRow | ContextRow)[];
    const row = this.mem.db
      .query(`SELECT COUNT(*) AS c FROM ${table} WHERE status = ?`)
      .get(status) as { c: number };
    return { items, total: row.c };
  }
}
