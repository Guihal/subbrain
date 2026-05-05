/**
 * SharedTable — orchestrator for shared_memory + agent_memory + vec_embeddings.
 * Public API stable; SQL split into:
 * shared-crud.ts (shared_memory CRUD), agent-mem.ts (agent_memory CRUD),
 * search-vec.ts (FTS5 + sqlite-vec + cross-layer M-09), helpers.ts
 * (filters + ALLOW maps + InsertSharedOpts).
 */
import type { Database } from "bun:sqlite";
import type {
  AgentMemRow,
  FtsResult,
  MemoryKind,
  MemoryStatus,
  SharedRow,
  VecResult,
} from "../../types";
import * as agent from "./agent-mem";
import * as sv from "./search-vec";
import * as crud from "./shared-crud";

export type { InsertSharedOpts } from "./helpers";

type SharedFields = {
  content?: string;
  tags?: string;
  category?: string;
  status?: MemoryStatus;
  confidence?: number | null;
  expires_at?: number | null;
  superseded_by?: string | null;
  kind?: MemoryKind;
};

export class SharedTable {
  constructor(public readonly db: Database) {}

  // ─── shared_memory ───────────────────────────────
  insertShared(
    id: string,
    category: string,
    content: string,
    tags: string = "",
    source?: string,
    opts?: import("./helpers").InsertSharedOpts,
  ): void {
    crud.insertShared(this.db, id, category, content, tags, source, opts);
  }
  getAllShared = (): SharedRow[] => crud.getAllShared(this.db);
  listShared = (
    limit: number = 50,
    offset: number = 0,
    category?: string,
    kind?: MemoryKind,
  ): SharedRow[] => crud.listShared(this.db, limit, offset, category, kind);
  listSharedActive = (limit: number = 50, offset: number = 0, category?: string) =>
    crud.listSharedActive(this.db, limit, offset, category);
  countShared = (category?: string, kind?: MemoryKind): number =>
    crud.countShared(this.db, category, kind);
  getShared = (id: string): SharedRow | null => crud.getShared(this.db, id);
  getSharedMany = (
    ids: string[],
    opts?: { activeOnly?: boolean; notStale?: boolean },
  ): SharedRow[] => crud.getSharedMany(this.db, ids, opts);
  getSharedByCategory = (category: string): SharedRow[] =>
    crud.getSharedByCategory(this.db, category);
  updateShared = (id: string, fields: SharedFields): void => crud.updateShared(this.db, id, fields);
  deleteShared = (id: string): void => crud.deleteShared(this.db, id);

  // ─── agent_memory ────────────────────────────────
  getLatestAgentMemoryByAgentId = (agentId: string): AgentMemRow | null =>
    agent.getLatestAgentMemoryByAgentId(this.db, agentId);
  updateAgentMemoryContent = (id: string, content: string): void =>
    agent.updateAgentMemoryContent(this.db, id, content);
  insertAgentMemory = (id: string, agentId: string, content: string, tags: string = ""): void =>
    agent.insertAgentMemory(this.db, id, agentId, content, tags);
  getAgentMemories = (agentId: string): AgentMemRow[] => agent.getAgentMemories(this.db, agentId);
  listAllAgentMemories = (
    limit: number = 50,
    offset: number = 0,
    agentId?: string,
  ): AgentMemRow[] => agent.listAllAgentMemories(this.db, limit, offset, agentId);
  countAgentMemories = (agentId?: string): number => agent.countAgentMemories(this.db, agentId);
  listAgentIds = (): string[] => agent.listAgentIds(this.db);
  getAgentMemory = (id: string): AgentMemRow | null => agent.getAgentMemory(this.db, id);
  updateAgentMemory = (id: string, fields: { content?: string; tags?: string }): void =>
    agent.updateAgentMemory(this.db, id, fields);
  deleteAgentMemory = (id: string): void => agent.deleteAgentMemory(this.db, id);

  // ─── FTS5 + Vec ──────────────────────────────────
  searchShared = (
    query: string,
    limit: number = 10,
    opts?: { activeOnly?: boolean; notStale?: boolean },
  ): FtsResult[] => sv.searchShared(this.db, query, limit, opts);

  upsertEmbedding = (id: string, layer: string, embedding: Float32Array): void =>
    sv.upsertEmbedding(this.db, id, layer, embedding);
  searchEmbeddings = (embedding: Float32Array, limit: number = 10, layer?: string): VecResult[] =>
    sv.searchEmbeddings(this.db, embedding, limit, layer);
  deleteEmbedding = (id: string): void => sv.deleteEmbedding(this.db, id);

  // M-09 cross-layer
  recentActiveSharedForCrossLayer = (limit: number) =>
    sv.recentActiveSharedForCrossLayer(this.db, limit);
  getEmbeddingsByIds = (layer: string, ids: string[]): Map<string, Float32Array> =>
    sv.getEmbeddingsByIds(this.db, layer, ids);
}
