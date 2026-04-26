/**
 * MemoryService — PR 25b (LAYER-2) + PR 27 (Repository swap).
 *
 * Owns every memory DB call the HTTP memory surface used to do inline. The
 * route (`src/routes/memory.ts`) stays thin (TypeBox + `paginate()`
 * envelope); this service owns embed+transaction atomicity, status filters,
 * pending queries.
 *
 * PR 27 change: ctor now takes `MemoryRepository` instead of the `MemoryDB`
 * god-object. The repo exposes exactly the per-table methods we need and
 * owns the previously-leaked `listByStatus` raw SQL. No other observable
 * behaviour change — tests pass `memory.memoryRepo` or construct the repo
 * directly.
 *
 * Conventions (.claude/skills/subbrain-guardrails/SKILL.md):
 *   - List methods return `{items,total}` → route wraps in `paginate` (§8).
 *   - Mutations through table-class helpers backed by `updateRow` (§4).
 *   - Inserts: embed-first then one `repo.transaction()`, mirroring
 *     `post/extractors.ts:writeShared` so a failed embed never orphans a row
 *     without a vector (§4).
 *   - FTS via `MemoryRepository.search*` (which calls `sanitizeFtsQuery`
 *     internally, §4); service does not re-sanitize.
 */
import { randomUUID } from "crypto";
import type {
  SharedRow,
  ContextRow,
  ArchiveRow,
  AgentMemRow,
  LogRow,
  MemoryStatus,
  MemoryKind,
} from "../db";
import type { MemoryRepository, LogRepository } from "../repositories";
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
  // MEM-6: when true, hide superseded + expired rows from list/search results.
  // Admin UI default = false (sees full audit trail). RAG/pre never call into
  // this service, so default-false is safe.
  active?: boolean;
  // M-07 (mig 12): filter shared list by kind. Ignored on non-shared layers.
  kind?: MemoryKind;
};

export type InsertSharedInput = {
  category: string;
  content: string;
  tags?: string;
  source?: string;
  confidence?: number | null;
  status?: MemoryStatus;
  // M-07: optional kind override; default 'semantic' applies via SQL DEFAULT.
  kind?: MemoryKind;
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
  constructor(
    private readonly repo: MemoryRepository,
    private readonly rag: RAGPipeline,
    private readonly logRepo: LogRepository,
  ) {}

  // ─── Focus (L1, KV) ───────────────────────────────────────
  listFocus(): Record<string, string> { return this.repo.getAllFocus(); }
  upsertFocus(key: string, value: string): void { this.repo.setFocus(key, value); }
  deleteFocus(key: string): void { this.repo.deleteFocus(key); }

  // ─── Shared ───────────────────────────────────────────────
  listShared(opts: ListOpts): PaginatedResult<SharedRow> {
    // MEM-6: `?active=true` → hide superseded/expired AND status!='active'.
    if (opts.q) {
      const filter = opts.active ? { activeOnly: true, notStale: true } : undefined;
      const hits = this.repo.searchShared(opts.q, opts.limit, filter);
      let items = hits
        .map((h) => this.repo.getShared(h.id))
        .filter((r): r is SharedRow => r !== null);
      // M-07: kind filter applied post-FTS (search doesn't index kind column).
      if (opts.kind) items = items.filter((r) => r.kind === opts.kind);
      return { items, total: items.length };
    }
    if (opts.status) return this.listByStatus("shared", opts.status, opts.limit, opts.offset) as PaginatedResult<SharedRow>;
    if (opts.active) {
      return this.repo.listSharedActive(opts.limit, opts.offset, opts.category);
    }
    return {
      items: this.repo.listShared(opts.limit, opts.offset, opts.category, opts.kind),
      total: this.repo.countShared(opts.category, opts.kind),
    };
  }
  getShared(id: string): SharedRow | null { return this.repo.getShared(id); }

  /** Embed-first then transactional insert+upsertEmbedding (§4). */
  async insertShared(input: InsertSharedInput): Promise<string> {
    const id = randomUUID();
    const vec = await embedWithTimeout(this.rag, input.content);
    if (!vec || vec.length === 0) throw new Error("embed_empty");
    this.repo.transaction(() => {
      this.repo.insertShared(
        id, input.category, input.content, input.tags ?? "", input.source,
        {
          confidence: input.confidence ?? null,
          status: input.status,
          kind: input.kind,
        },
      );
      this.repo.upsertEmbedding(id, "shared", vec);
    });
    return id;
  }
  patchShared(id: string, patch: UpdateSharedPatch): SharedRow | null {
    this.repo.updateShared(id, patch);
    return this.repo.getShared(id);
  }
  // M-4 / MEM-4: pair the row delete with vec delete so vec_embeddings
  // never carries an orphan row. Wrapped in a transaction so a crash
  // between the two leaves the DB consistent (no half-deleted entry).
  deleteShared(id: string): void {
    this.repo.transaction(() => {
      this.repo.deleteShared(id);
      this.repo.deleteEmbedding(id);
    });
  }

  // ─── Context (L2) ─────────────────────────────────────────
  // B-1 note: MemoryService backs the admin /v1/memory/* routes — no
  // agentId is threaded here, so search returns rows from every agent.
  // The agent-loop reaches context through the registry's memory_search /
  // rag_search handlers, which DO pass `ctx.agentId`.
  listContext(opts: ListOpts): PaginatedResult<ContextRow> {
    // MEM-6: `?active=true` → hide superseded/expired AND status!='active'.
    if (opts.q) {
      const filter = opts.active ? { activeOnly: true, notStale: true } : undefined;
      const hits = this.repo.searchContext(opts.q, opts.limit, filter);
      const items = hits.map((h) => this.repo.getContext(h.id)).filter((r): r is ContextRow => r !== null);
      return { items, total: items.length };
    }
    if (opts.status) return this.listByStatus("context", opts.status, opts.limit, opts.offset) as PaginatedResult<ContextRow>;
    if (opts.active) {
      return this.repo.listContextActive(opts.limit, opts.offset);
    }
    return { items: this.repo.listContext(opts.limit, opts.offset), total: this.repo.countContext() };
  }
  getContext(id: string): ContextRow | null { return this.repo.getContext(id); }

  async insertContext(input: InsertContextInput): Promise<string> {
    const id = randomUUID();
    const vec = await embedWithTimeout(this.rag, input.content);
    if (!vec || vec.length === 0) throw new Error("embed_empty");
    this.repo.transaction(() => {
      this.repo.insertContext(
        id, input.title, input.content, input.tags ?? "", input.derivedFrom ?? [], input.agentId,
        { confidence: input.confidence ?? null, status: input.status },
      );
      this.repo.upsertEmbedding(id, "context", vec);
    });
    return id;
  }
  patchContext(id: string, patch: UpdateContextPatch): ContextRow | null {
    this.repo.updateContext(id, patch);
    return this.repo.getContext(id);
  }
  // M-4 / MEM-4: pair row + vec deletion atomically.
  deleteContext(id: string): void {
    this.repo.transaction(() => {
      this.repo.deleteContext(id);
      this.repo.deleteEmbedding(id);
    });
  }

  // ─── Archive (L3) ─────────────────────────────────────────
  listArchive(opts: ListOpts): PaginatedResult<ArchiveRow> {
    if (opts.q) {
      const hits = this.repo.searchArchive(opts.q, opts.limit);
      const items = hits.map((h) => this.repo.getArchive(h.id)).filter((r): r is ArchiveRow => r !== null);
      return { items, total: items.length };
    }
    return { items: this.repo.listArchive(opts.limit, opts.offset), total: this.repo.countArchive() };
  }
  getArchive(id: string): ArchiveRow | null { return this.repo.getArchive(id); }
  patchArchive(id: string, patch: UpdateArchivePatch): ArchiveRow | null {
    this.repo.updateArchive(id, patch);
    return this.repo.getArchive(id);
  }
  // M-4 / MEM-4: pair row + vec deletion atomically.
  deleteArchive(id: string): void {
    this.repo.transaction(() => {
      this.repo.deleteArchive(id);
      this.repo.deleteEmbedding(id);
    });
  }

  // ─── Agent memory ─────────────────────────────────────────
  listAgentIds(): string[] { return this.repo.listAgentIds(); }
  listAgent(opts: ListOpts): PaginatedResult<AgentMemRow> {
    return {
      items: this.repo.listAllAgentMemories(opts.limit, opts.offset, opts.agentId),
      total: this.repo.countAgentMemories(opts.agentId),
    };
  }
  getAgent(id: string): AgentMemRow | null { return this.repo.getAgentMemory(id); }
  patchAgent(id: string, patch: UpdateAgentPatch): AgentMemRow | null {
    this.repo.updateAgentMemory(id, patch);
    return this.repo.getAgentMemory(id);
  }
  deleteAgent(id: string): void { this.repo.deleteAgentMemory(id); }

  // ─── Log (L4, read-only) ──────────────────────────────────
  listLog(opts: ListOpts): PaginatedResult<LogRow> {
    return {
      items: this.logRepo.listLog(opts.limit, opts.offset, opts.sessionId),
      total: this.logRepo.countLog(opts.sessionId),
    };
  }
  listLogSessions(limit = 50): string[] {
    return this.logRepo.listLogSessions(limit);
  }

  // ─── Pending / status (22b compat) ────────────────────────
  listPending(layer: PendingLayer, opts: { limit: number; offset: number }): PaginatedResult<SharedRow | ContextRow> {
    return this.listByStatus(layer, "pending", opts.limit, opts.offset);
  }
  setStatus(
    layer: PendingLayer,
    id: string,
    status: MemoryStatus,
  ): SharedRow | ContextRow | null {
    return this.repo.setStatusSafe(layer, id, status);
  }

  /** Delegates to repo (moved in PR 27, used to be raw SQL in this file). */
  private listByStatus(
    layer: PendingLayer,
    status: MemoryStatus,
    limit: number,
    offset: number,
  ): PaginatedResult<SharedRow | ContextRow> {
    return this.repo.listByStatus(layer, status, limit, offset);
  }
}
