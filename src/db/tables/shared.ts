import { Database, type SQLQueryBindings } from "bun:sqlite";
import { sanitizeFtsQuery } from "../../lib/fts-utils";
import type { SharedRow, AgentMemRow, FtsResult, VecResult } from "../types";

export class SharedTable {
  constructor(public readonly db: Database) {}

  // ─── Shared Memory ─────────────────────────────────────────

  insertShared(id: string, category: string, content: string, tags: string = "", source?: string): void {
    this.db
      .query("INSERT INTO shared_memory (id, category, content, tags, source) VALUES (?, ?, ?, ?, ?)")
      .run(id, category, content, tags, source ?? null);
  }

  getAllShared(): SharedRow[] {
    return this.db
      .query("SELECT * FROM shared_memory ORDER BY updated_at DESC")
      .all() as SharedRow[];
  }

  listShared(limit = 50, offset = 0, category?: string): SharedRow[] {
    if (category) {
      return this.db
        .query("SELECT * FROM shared_memory WHERE category = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?")
        .all(category, limit, offset) as SharedRow[];
    }
    return this.db
      .query("SELECT * FROM shared_memory ORDER BY updated_at DESC LIMIT ? OFFSET ?")
      .all(limit, offset) as SharedRow[];
  }

  countShared(category?: string): number {
    if (category) {
      const row = this.db
        .query("SELECT COUNT(*) AS c FROM shared_memory WHERE category = ?")
        .get(category) as { c: number };
      return row.c;
    }
    const row = this.db.query("SELECT COUNT(*) AS c FROM shared_memory").get() as { c: number };
    return row.c;
  }

  getShared(id: string): SharedRow | null {
    return this.db.query("SELECT * FROM shared_memory WHERE id = ?").get(id) as SharedRow | null;
  }

  getSharedByCategory(category: string): SharedRow[] {
    return this.db
      .query("SELECT * FROM shared_memory WHERE category = ? ORDER BY updated_at DESC")
      .all(category) as SharedRow[];
  }

  updateShared(id: string, fields: { content?: string; tags?: string; category?: string }): void {
    const sets: string[] = ["updated_at = unixepoch()"];
    const vals: SQLQueryBindings[] = [];
    if (fields.content !== undefined) { sets.push("content = ?"); vals.push(fields.content); }
    if (fields.tags !== undefined) { sets.push("tags = ?"); vals.push(fields.tags); }
    if (fields.category !== undefined) { sets.push("category = ?"); vals.push(fields.category); }
    vals.push(id);
    this.db.query(`UPDATE shared_memory SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  }

  deleteShared(id: string): void {
    this.db.query("DELETE FROM shared_memory WHERE id = ?").run(id);
  }

  // ─── Agent Memory ──────────────────────────────────────────

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
    const sets: string[] = ["updated_at = unixepoch()"];
    const vals: SQLQueryBindings[] = [];
    if (fields.content !== undefined) { sets.push("content = ?"); vals.push(fields.content); }
    if (fields.tags !== undefined) { sets.push("tags = ?"); vals.push(fields.tags); }
    if (sets.length === 1) return;
    vals.push(id);
    this.db.query(`UPDATE agent_memory SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  }

  deleteAgentMemory(id: string): void {
    this.db.query("DELETE FROM agent_memory WHERE id = ?").run(id);
  }

  // ─── FTS5 Search (shared) ──────────────────────────────────

  searchShared(query: string, limit = 10): FtsResult[] {
    const ftsQuery = sanitizeFtsQuery(query);
    if (!ftsQuery) return [];
    return this.db
      .query(
        "SELECT s.id, s.category AS title, s.tags, snippet(fts_shared, 1, '<b>', '</b>', '...', 32) AS snippet, rank, s.created_at, s.updated_at FROM fts_shared f JOIN shared_memory s ON s.rowid = f.rowid WHERE fts_shared MATCH ? ORDER BY rank LIMIT ?",
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
}
