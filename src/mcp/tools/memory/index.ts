/**
 * Memory CRUD operations extracted from ToolExecutor.
 *
 * MEM-2 (M-01): the `shared` layer write path embeds **before** insert and
 * wraps both rows (`shared_memory` + `vec_embeddings`) in a single
 * `db.transaction()`. Two paths exist:
 *
 *   1. Preferred (M-FINAL2): a `MemoryService` is injected via
 *      `setMemoryService` — `MemoryTools.write` delegates `case shared` to
 *      `memoryService.insertShared`, the single source of embed-first +
 *      transactional shared writes (mirrors `extractors.writeShared`).
 *   2. Legacy fallback: when no service is wired (older tests construct
 *      `new MemoryTools(db, () => rag)` directly), the inline
 *      `writeSharedAtomic` keeps the same atomicity guarantee.
 *
 * M-07.1: both paths derive `kind` from `category` via `categoryToKind` so
 * persona-grade rows (profile / preference / relationship) pick up the +10%
 * RAG rerank boost regardless of which path runs.
 *
 * This `index.ts` is the public entry point of the split-folder; it keeps
 * the class API (read/write/delete/search/contextSummary/setMemoryService)
 * stable and delegates each method to a pure function in a sibling file.
 */
import type { MemoryDB } from "../../../db";
import type { RAGPipeline } from "../../../rag";
import type { MemoryService } from "../../../services/memory.service";
import type { ToolResult } from "../../types";
import { readMemory } from "./read";
import { writeMemory, type WriteParams } from "./write";
import { deleteMemory } from "./delete";
import { searchMemory } from "./search";
import { contextSummary } from "./context-summary";

export class MemoryTools {
  /**
   * M-FINAL2: optional service injection. Wired from
   * `ToolExecutor.setMemoryService` after `initDeps` constructs the service
   * (which depends on RAG, which is set post-ctor too — so we cannot pass
   * it through the constructor without breaking the existing setRAG
   * ordering). Legacy tests skip this and fall through to
   * `writeSharedAtomic`.
   */
  private memoryService: MemoryService | null = null;

  constructor(
    private memory: MemoryDB,
    private getRag: () => RAGPipeline | null,
  ) {}

  setMemoryService(service: MemoryService): void {
    this.memoryService = service;
  }

  read(id: string, layer?: string): ToolResult {
    return readMemory(this.memory, id, layer);
  }

  write(
    params: WriteParams,
    agentId: string | null = null,
  ): ToolResult | Promise<ToolResult> {
    return writeMemory(
      {
        memory: this.memory,
        getRag: this.getRag,
        memoryService: this.memoryService,
      },
      params,
      agentId,
    );
  }

  delete(id: string, layer: string, agentId: string | null = null): ToolResult {
    return deleteMemory(this.memory, id, layer, agentId);
  }

  search(
    query: string,
    layer?: string,
    limit?: number,
    agentId: string | null = null,
  ): ToolResult {
    return searchMemory(this.memory, query, layer, limit, agentId);
  }

  contextSummary(sessionId: string): ToolResult {
    return contextSummary(this.memory, sessionId);
  }
}
