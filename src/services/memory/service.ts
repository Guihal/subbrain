/**
 * MemoryService — PR 25b (LAYER-2) + PR 27 (Repository swap) + W3-1 (split).
 *
 * Owns the HTTP memory surface end of things. Routes stay thin; this service
 * owns embed + transaction atomicity, status filters, pending queries.
 */
import type {
  AgentMemRow,
  ArchiveRow,
  ContextRow,
  EdgeKind,
  LogRow,
  MemoryDB,
  MemoryStatus,
  SharedRow,
} from "@subbrain/core/db";
import type { LogRepository, MemoryRepository } from "@subbrain/core/repositories";
import type { RAGPipeline } from "../../rag";
import * as al from "./agent-log-ops";
import * as arch from "./archive-ops";
import * as ctx from "./context-ops";
import { runLinkRelated } from "./link";
import * as shared from "./shared-ops";
import type {
  EdgeLayer,
  InsertContextInput,
  InsertSharedInput,
  ListOpts,
  MemoryServiceLinkDeps,
  PaginatedResult,
  PendingLayer,
  RelatedEdge,
  UpdateAgentPatch,
  UpdateArchivePatch,
  UpdateContextPatch,
  UpdateSharedPatch,
} from "./types";

export class MemoryService {
  constructor(
    private readonly repo: MemoryRepository,
    private readonly rag: RAGPipeline,
    private readonly logRepo: LogRepository,
    private readonly memoryDb: MemoryDB | null = null,
    private readonly linkDeps: MemoryServiceLinkDeps | null = null,
  ) {}

  listFocus(): Record<string, string> {
    return this.repo.getAllFocus();
  }
  upsertFocus(key: string, value: string): void {
    this.repo.setFocus(key, value);
  }
  deleteFocus(key: string): void {
    this.repo.deleteFocus(key);
  }

  listShared(opts: ListOpts): PaginatedResult<SharedRow> {
    return shared.listShared(this.sharedDeps(), opts);
  }
  getShared(id: string): SharedRow | null {
    return this.repo.getShared(id);
  }
  async insertShared(input: InsertSharedInput): Promise<string> {
    const id = await shared.insertShared(this.sharedDeps(), input);
    await runLinkRelated(
      this.memoryDb,
      this.rag,
      this.linkDeps,
      id,
      "shared",
      input.content,
      input.tags ?? "",
    );
    return id;
  }
  patchShared(id: string, patch: UpdateSharedPatch): SharedRow | null {
    return shared.patchShared(this.repo, id, patch);
  }
  deleteShared(id: string): void {
    shared.deleteShared(this.repo, id);
  }

  listContext(opts: ListOpts): PaginatedResult<ContextRow> {
    return ctx.listContext(this.contextDeps(), opts);
  }
  getContext(id: string): ContextRow | null {
    return this.repo.getContext(id);
  }
  async insertContext(input: InsertContextInput): Promise<string> {
    const id = await ctx.insertContext(this.contextDeps(), input);
    await runLinkRelated(
      this.memoryDb,
      this.rag,
      this.linkDeps,
      id,
      "context",
      input.content,
      input.tags ?? "",
    );
    return id;
  }
  patchContext(id: string, patch: UpdateContextPatch): ContextRow | null {
    return ctx.patchContext(this.repo, id, patch);
  }
  deleteContext(id: string): void {
    ctx.deleteContext(this.repo, id);
  }

  listArchive(opts: ListOpts): PaginatedResult<ArchiveRow> {
    return arch.listArchive(this.repo, opts);
  }
  getArchive(id: string): ArchiveRow | null {
    return this.repo.getArchive(id);
  }
  patchArchive(id: string, patch: UpdateArchivePatch): ArchiveRow | null {
    return arch.patchArchive(this.repo, id, patch);
  }
  deleteArchive(id: string): void {
    arch.deleteArchive(this.repo, id);
  }

  listAgentIds(): string[] {
    return this.repo.listAgentIds();
  }
  listAgent(opts: ListOpts): PaginatedResult<AgentMemRow> {
    return al.listAgent(this.repo, opts);
  }
  getAgent(id: string): AgentMemRow | null {
    return this.repo.getAgentMemory(id);
  }
  patchAgent(id: string, patch: UpdateAgentPatch): AgentMemRow | null {
    return al.patchAgent(this.repo, id, patch);
  }
  deleteAgent(id: string): void {
    this.repo.deleteAgentMemory(id);
  }

  listLog(opts: ListOpts): PaginatedResult<LogRow> {
    return al.listLog(this.logRepo, opts);
  }
  listLogSessions(limit = 50): string[] {
    return this.logRepo.listLogSessions(limit);
  }

  listPending(layer: PendingLayer, opts: { limit: number; offset: number }) {
    return this.repo.listByStatus(layer, "pending", opts.limit, opts.offset);
  }
  setStatus(layer: PendingLayer, id: string, status: MemoryStatus) {
    return this.repo.setStatusSafe(layer, id, status);
  }

  getEdgesFromSrc(srcId: string, srcLayer: EdgeLayer, kinds?: EdgeKind[]) {
    return this.memoryDb ? this.memoryDb.getEdgesFromSrc(srcId, srcLayer, kinds) : [];
  }
  getRelatedDetailed(id: string, layer: EdgeLayer, kinds?: EdgeKind[]): RelatedEdge[] {
    return this.memoryDb ? this.memoryDb.getRelated(id, layer, 1, kinds) : [];
  }

  private sharedDeps(): shared.SharedDeps {
    return {
      repo: this.repo,
      rag: this.rag,
      listByStatus: (l, s, lim, off) =>
        this.repo.listByStatus(l, s, lim, off) as PaginatedResult<SharedRow>,
    };
  }

  private contextDeps(): ctx.ContextDeps {
    return {
      repo: this.repo,
      rag: this.rag,
      listByStatus: (l, s, lim, off) =>
        this.repo.listByStatus(l, s, lim, off) as PaginatedResult<ContextRow>,
    };
  }
}
