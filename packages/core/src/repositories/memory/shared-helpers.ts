import type { MemoryKind, MemoryStatus } from "../../db/index";
import type { InsertSharedOpts, SharedTable } from "../../db/tables/shared";

/**
 * Thin facades around `SharedTable` — shared CRUD, agent memory, FTS5, vec
 * embeddings, recent helpers. `MemoryRepository` `Object.assign`s these onto
 * itself.
 */
export function makeSharedHelpers(shared: SharedTable) {
  return {
    // Shared CRUD
    insertShared: (
      id: string,
      category: string,
      content: string,
      tags?: string,
      source?: string,
      opts?: InsertSharedOpts,
    ) => shared.insertShared(id, category, content, tags, source, opts),
    getAllShared: () => shared.getAllShared(),
    listShared: (limit?: number, offset?: number, category?: string, kind?: MemoryKind) =>
      shared.listShared(limit, offset, category, kind),
    listSharedActive: (limit?: number, offset?: number, category?: string) =>
      shared.listSharedActive(limit, offset, category),
    countShared: (category?: string, kind?: MemoryKind) => shared.countShared(category, kind),
    getShared: (id: string) => shared.getShared(id),
    getSharedMany: (ids: string[], opts?: { activeOnly?: boolean; notStale?: boolean }) =>
      shared.getSharedMany(ids, opts),
    getSharedByCategory: (category: string) => shared.getSharedByCategory(category),
    updateShared: (
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
        // P3-2 (mig 17): bi-temporal columns.
        valid_from?: number | null;
        valid_to?: number | null;
        observed_at?: number | null;
      },
    ) => shared.updateShared(id, fields),
    deleteShared: (id: string) => shared.deleteShared(id),

    // Agent memory
    insertAgentMemory: (id: string, agentId: string, content: string, tags?: string) =>
      shared.insertAgentMemory(id, agentId, content, tags),
    getAgentMemories: (agentId: string) => shared.getAgentMemories(agentId),
    /** PR B-2: lift `agent-loop/persist.ts` raw SQL out of the pipeline. */
    getLatestAgentMemoryByAgentId: (agentId: string) =>
      shared.getLatestAgentMemoryByAgentId(agentId),
    updateAgentMemoryContent: (id: string, content: string) =>
      shared.updateAgentMemoryContent(id, content),
    listAllAgentMemories: (limit?: number, offset?: number, agentId?: string) =>
      shared.listAllAgentMemories(limit, offset, agentId),
    countAgentMemories: (agentId?: string) => shared.countAgentMemories(agentId),
    listAgentIds: () => shared.listAgentIds(),
    getAgentMemory: (id: string) => shared.getAgentMemory(id),
    updateAgentMemory: (id: string, fields: { content?: string; tags?: string }) =>
      shared.updateAgentMemory(id, fields),
    deleteAgentMemory: (id: string) => shared.deleteAgentMemory(id),

    // FTS5 + vec
    searchShared: (
      query: string,
      limit?: number,
      opts?: { activeOnly?: boolean; notStale?: boolean },
    ) => shared.searchShared(query, limit, opts),
    upsertEmbedding: (id: string, layer: string, embedding: Float32Array) =>
      shared.upsertEmbedding(id, layer, embedding),
    searchEmbeddings: (embedding: Float32Array, limit?: number, layer?: string) =>
      shared.searchEmbeddings(embedding, limit, layer),
    deleteEmbedding: (id: string) => shared.deleteEmbedding(id),
    // M-09: bulk-fetch raw vectors for cross-layer cosine in JS.
    getEmbeddingsByIds: (layer: string, ids: string[]) => shared.getEmbeddingsByIds(layer, ids),
    recentActiveSharedForCrossLayer: (limit: number) =>
      shared.recentActiveSharedForCrossLayer(limit),
  };
}

export type SharedHelpers = ReturnType<typeof makeSharedHelpers>;
