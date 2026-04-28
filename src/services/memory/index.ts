/**
 * MemoryService — PR 25b (LAYER-2) + PR 27 (Repository swap) + W3-1 (split).
 *
 * Owns the HTTP memory surface end of things. Routes (`src/routes/memory.ts`)
 * stay thin (TypeBox + `paginate()` envelope); this service owns embed +
 * transaction atomicity, status filters, pending queries.
 *
 * Conventions (.claude/skills/subbrain-guardrails/SKILL.md):
 *   - List methods return `{items,total}` → route wraps in `paginate` (§8).
 *   - Mutations through table-class helpers backed by `updateRow` (§4).
 *   - Inserts: embed-first then one `repo.transaction()`, mirroring
 *     `post/extractors.ts:writeShared` so a failed embed never orphans a row
 *     without a vector (§4).
 *   - FTS via `MemoryRepository.search*` (calls `sanitizeFtsQuery` internally,
 *     §4); service does not re-sanitize.
 */
import type {
  SharedRow, ContextRow, ArchiveRow, AgentMemRow, LogRow,
  MemoryStatus, MemoryDB,
} from "../../db";
import type { EdgeKind } from "../../db/types";
import type { MemoryRepository, LogRepository } from "../../repositories";
import type { RAGPipeline } from "../../rag";
import { runLinkRelated } from "./link";
import * as shared from "./shared-ops";
import * as ctx from "./context-ops";
import * as arch from "./archive-ops";
import * as al from "./agent-log-ops";
import type {
  EdgeLayer, MemoryServiceLinkDeps, PaginatedResult, ListOpts,
  InsertSharedInput, InsertContextInput,
  UpdateSharedPatch, UpdateContextPatch, UpdateArchivePatch, UpdateAgentPatch,
  PendingLayer, RelatedEdge,
} from "./types";

export type {
  EdgeLayer, MemoryServiceLinkDeps, PaginatedResult, ListOpts,
  InsertSharedInput, InsertContextInput,
  UpdateSharedPatch, UpdateContextPatch, UpdateArchivePatch, UpdateAgentPatch,
  RelatedEdge,
};

export class MemoryService {
  constructor(
    private readonly repo: MemoryRepository,
    private readonly rag: RAGPipeline,
    private readonly logRepo: LogRepository,
    // M-13: MemoryDB facade required by `linkRelated`. Default null so
    // existing 3-arg test/script callers continue to work — they skip the hook.
    private readonly memoryDb: MemoryDB | null = null,
    // M-13: when both `linkDeps` and `memoryDb` set, post-hook fires on every
    // successful insertShared/insertContext. Throw is logged as warn, never
    // aborts the write.
    private readonly linkDeps: MemoryServiceLinkDeps | null = null,
  ) {}

  // ─── Focus (L1, KV) ───────────────────────────────────────
  listFocus(): Record<string, string> { return this.repo.getAllFocus(); }
  upsertFocus(key: string, value: string): void { this.repo.setFocus(key, value); }
  deleteFocus(key: string): void { this.repo.deleteFocus(key); }

  // ─── Shared ───────────────────────────────────────────────
  listShared(opts: ListOpts): PaginatedResult<SharedRow> {
    return shared.listShared(this.sharedDeps(), opts);
  }
  getShared(id: string): SharedRow | null { return this.repo.getShared(id); }
  async insertShared(input: InsertSharedInput): Promise<string> {
    const id = await shared.insertShared(this.sharedDeps(), input);
    await runLinkRelated(this.memoryDb, this.rag, this.linkDeps, id, "shared", input.content, input.tags ?? "");
    return id;
  }
  patchShared(id: string, patch: UpdateSharedPatch): SharedRow | null {
    return shared.patchShared(this.repo, id, patch);
  }
  deleteShared(id: string): void { shared.deleteShared(this.repo, id); }

  // ─── Context (L2) ─────────────────────────────────────────
  listContext(opts: ListOpts): PaginatedResult<ContextRow> {
    return ctx.listContext(this.contextDeps(), opts);
  }
  getContext(id: string): ContextRow | null { return this.repo.getContext(id); }
  async insertContext(input: InsertContextInput): Promise<string> {
    const id = await ctx.insertContext(this.contextDeps(), input);
    await runLinkRelated(this.memoryDb, this.rag, this.linkDeps, id, "context", input.content, input.tags ?? "");
    return id;
  }
  patchContext(id: string, patch: UpdateContextPatch): ContextRow | null {
    return ctx.patchContext(this.repo, id, patch);
  }
  deleteContext(id: string): void { ctx.deleteContext(this.repo, id); }

  // ─── Archive (L3) ─────────────────────────────────────────
  listArchive(opts: ListOpts): PaginatedResult<ArchiveRow> { return arch.listArchive(this.repo, opts); }
  getArchive(id: string): ArchiveRow | null { return this.repo.getArchive(id); }
  patchArchive(id: string, patch: UpdateArchivePatch): ArchiveRow | null {
    return arch.patchArchive(this.repo, id, patch);
  }
  deleteArchive(id: string): void { arch.deleteArchive(this.repo, id); }

  // ─── Agent memory ─────────────────────────────────────────
  listAgentIds(): string[] { return this.repo.listAgentIds(); }
  listAgent(opts: ListOpts): PaginatedResult<AgentMemRow> { return al.listAgent(this.repo, opts); }
  getAgent(id: string): AgentMemRow | null { return this.repo.getAgentMemory(id); }
  patchAgent(id: string, patch: UpdateAgentPatch): AgentMemRow | null {
    return al.patchAgent(this.repo, id, patch);
  }
  deleteAgent(id: string): void { this.repo.deleteAgentMemory(id); }

  // ─── Log (L4, read-only) ──────────────────────────────────
  listLog(opts: ListOpts): PaginatedResult<LogRow> { return al.listLog(this.logRepo, opts); }
  listLogSessions(limit = 50): string[] { return this.logRepo.listLogSessions(limit); }

  // ─── Pending / status ─────────────────────────────────────
  listPending(layer: PendingLayer, opts: { limit: number; offset: number }) {
    return this.repo.listByStatus(layer, "pending", opts.limit, opts.offset);
  }
  setStatus(layer: PendingLayer, id: string, status: MemoryStatus) {
    return this.repo.setStatusSafe(layer, id, status);
  }

  // ─── Edges (M-05 / M-14, read-only admin surface) ────────
  // 3-arg test/script ctor → memoryDb=null → returns []; routes still serve
  // a valid empty envelope.
  getEdgesFromSrc(srcId: string, srcLayer: EdgeLayer, kinds?: EdgeKind[]) {
    return this.memoryDb ? this.memoryDb.getEdgesFromSrc(srcId, srcLayer, kinds) : [];
  }
  getRelatedDetailed(id: string, layer: EdgeLayer, kinds?: EdgeKind[]): RelatedEdge[] {
    return this.memoryDb ? this.memoryDb.getRelated(id, layer, 1, kinds) : [];
  }

  private sharedDeps(): shared.SharedDeps {
    return {
      repo: this.repo, rag: this.rag,
      listByStatus: (l, s, lim, off) =>
        this.repo.listByStatus(l, s, lim, off) as PaginatedResult<SharedRow>,
    };
  }

  private contextDeps(): ctx.ContextDeps {
    return {
      repo: this.repo, rag: this.rag,
      listByStatus: (l, s, lim, off) =>
        this.repo.listByStatus(l, s, lim, off) as PaginatedResult<ContextRow>,
    };
  }
}
