import { Database } from "bun:sqlite";
import { openDatabase, migrate, EMBEDDING_DIM } from "./schema";

export class MemoryDB {
  db: Database;

  constructor(path: string) {
    this.db = openDatabase(path);
    migrate(this.db);
  }

  close(): void {
    this.db.close();
  }

  // ─── Layer 1: Focus ────────────────────────────────────────

  getFocus(key: string): string | null {
    const row = this.db
      .query("SELECT value FROM layer1_focus WHERE key = ?")
      .get(key) as { value: string } | null;
    return row?.value ?? null;
  }

  setFocus(key: string, value: string): void {
    this.db
      .query(
        "INSERT INTO layer1_focus (key, value, updated_at) VALUES (?, ?, unixepoch()) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      )
      .run(key, value);
  }

  getAllFocus(): Record<string, string> {
    const rows = this.db.query("SELECT key, value FROM layer1_focus").all() as {
      key: string;
      value: string;
    }[];
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  // ─── Layer 2: Context ──────────────────────────────────────

  insertContext(
    id: string,
    title: string,
    content: string,
    tags: string = "",
    derivedFrom: string[] = [],
    agentId?: string,
  ): void {
    this.db
      .query(
        "INSERT INTO layer2_context (id, title, content, tags, derived_from, agent_id) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        title,
        content,
        tags,
        JSON.stringify(derivedFrom),
        agentId ?? null,
      );
  }

  updateContext(
    id: string,
    fields: { title?: string; content?: string; tags?: string },
  ): void {
    const sets: string[] = ["updated_at = unixepoch()"];
    const vals: unknown[] = [];
    if (fields.title !== undefined) {
      sets.push("title = ?");
      vals.push(fields.title);
    }
    if (fields.content !== undefined) {
      sets.push("content = ?");
      vals.push(fields.content);
    }
    if (fields.tags !== undefined) {
      sets.push("tags = ?");
      vals.push(fields.tags);
    }
    vals.push(id);
    this.db
      .query(`UPDATE layer2_context SET ${sets.join(", ")} WHERE id = ?`)
      .run(...vals);
  }

  getContext(id: string): ContextRow | null {
    return this.db
      .query("SELECT * FROM layer2_context WHERE id = ?")
      .get(id) as ContextRow | null;
  }

  deleteContext(id: string): void {
    this.db.query("DELETE FROM layer2_context WHERE id = ?").run(id);
  }

  // ─── Layer 3: Archive ──────────────────────────────────────

  insertArchive(
    id: string,
    title: string,
    content: string,
    tags: string = "",
    sourceRequestIds: string[] = [],
    confidence: "HIGH" | "LOW" = "HIGH",
    agentId?: string,
  ): void {
    this.db
      .query(
        "INSERT INTO layer3_archive (id, title, content, tags, source_request_ids, confidence, agent_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        title,
        content,
        tags,
        JSON.stringify(sourceRequestIds),
        confidence,
        agentId ?? null,
      );
  }

  getArchive(id: string): ArchiveRow | null {
    return this.db
      .query("SELECT * FROM layer3_archive WHERE id = ?")
      .get(id) as ArchiveRow | null;
  }

  updateArchive(
    id: string,
    fields: {
      title?: string;
      content?: string;
      tags?: string;
      confidence?: "HIGH" | "LOW";
    },
  ): void {
    const sets: string[] = ["updated_at = unixepoch()"];
    const vals: unknown[] = [];
    if (fields.title !== undefined) {
      sets.push("title = ?");
      vals.push(fields.title);
    }
    if (fields.content !== undefined) {
      sets.push("content = ?");
      vals.push(fields.content);
    }
    if (fields.tags !== undefined) {
      sets.push("tags = ?");
      vals.push(fields.tags);
    }
    if (fields.confidence !== undefined) {
      sets.push("confidence = ?");
      vals.push(fields.confidence);
    }
    vals.push(id);
    this.db
      .query(`UPDATE layer3_archive SET ${sets.join(", ")} WHERE id = ?`)
      .run(...vals);
  }

  deleteArchive(id: string): void {
    this.db.query("DELETE FROM layer3_archive WHERE id = ?").run(id);
  }

  // ─── Layer 4: Raw Log ─────────────────────────────────────

  appendLog(
    requestId: string,
    sessionId: string,
    agentId: string,
    role: string,
    content: string,
    tokenCount?: number,
  ): number {
    const result = this.db
      .query(
        "INSERT INTO layer4_log (request_id, session_id, agent_id, role, content, token_count) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(requestId, sessionId, agentId, role, content, tokenCount ?? null);
    return Number(result.lastInsertRowid);
  }

  getLogsByRequest(requestId: string): LogRow[] {
    return this.db
      .query("SELECT * FROM layer4_log WHERE request_id = ? ORDER BY id")
      .all(requestId) as LogRow[];
  }

  getLogsBySession(sessionId: string, limit = 100): LogRow[] {
    return this.db
      .query(
        "SELECT * FROM layer4_log WHERE session_id = ? ORDER BY id DESC LIMIT ?",
      )
      .all(sessionId, limit) as LogRow[];
  }

  /** Get log entries with id > afterId, ordered by id ASC. */
  getLogsSince(afterId: number, limit = 500): LogRow[] {
    return this.db
      .query("SELECT * FROM layer4_log WHERE id > ? ORDER BY id ASC LIMIT ?")
      .all(afterId, limit) as LogRow[];
  }

  /** Group log entries by session_id from a list of rows. */
  groupLogsBySession(rows: LogRow[]): Map<string, LogRow[]> {
    const groups = new Map<string, LogRow[]>();
    for (const row of rows) {
      const arr = groups.get(row.session_id) || [];
      arr.push(row);
      groups.set(row.session_id, arr);
    }
    return groups;
  }

  // ─── Shared Memory ─────────────────────────────────────────

  insertShared(
    id: string,
    category: string,
    content: string,
    tags: string = "",
    source?: string,
  ): void {
    this.db
      .query(
        "INSERT INTO shared_memory (id, category, content, tags, source) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, category, content, tags, source ?? null);
  }

  getAllShared(): SharedRow[] {
    return this.db
      .query("SELECT * FROM shared_memory ORDER BY updated_at DESC")
      .all() as SharedRow[];
  }

  getSharedByCategory(category: string): SharedRow[] {
    return this.db
      .query(
        "SELECT * FROM shared_memory WHERE category = ? ORDER BY updated_at DESC",
      )
      .all(category) as SharedRow[];
  }

  updateShared(
    id: string,
    fields: { content?: string; tags?: string; category?: string },
  ): void {
    const sets: string[] = ["updated_at = unixepoch()"];
    const vals: unknown[] = [];
    if (fields.content !== undefined) {
      sets.push("content = ?");
      vals.push(fields.content);
    }
    if (fields.tags !== undefined) {
      sets.push("tags = ?");
      vals.push(fields.tags);
    }
    if (fields.category !== undefined) {
      sets.push("category = ?");
      vals.push(fields.category);
    }
    vals.push(id);
    this.db
      .query(`UPDATE shared_memory SET ${sets.join(", ")} WHERE id = ?`)
      .run(...vals);
  }

  deleteShared(id: string): void {
    this.db.query("DELETE FROM shared_memory WHERE id = ?").run(id);
  }

  // ─── Agent Memory ──────────────────────────────────────────

  insertAgentMemory(
    id: string,
    agentId: string,
    content: string,
    tags: string = "",
  ): void {
    this.db
      .query(
        "INSERT INTO agent_memory (id, agent_id, content, tags) VALUES (?, ?, ?, ?)",
      )
      .run(id, agentId, content, tags);
  }

  getAgentMemories(agentId: string): AgentMemRow[] {
    return this.db
      .query(
        "SELECT * FROM agent_memory WHERE agent_id = ? ORDER BY updated_at DESC",
      )
      .all(agentId) as AgentMemRow[];
  }

  deleteAgentMemory(id: string): void {
    this.db.query("DELETE FROM agent_memory WHERE id = ?").run(id);
  }

  // ─── FTS5 Search ───────────────────────────────────────────

  searchContext(query: string, limit = 10): FtsResult[] {
    return this.db
      .query(
        "SELECT c.id, c.title, c.tags, snippet(fts_context, 1, '<b>', '</b>', '...', 32) AS snippet, rank, c.created_at, c.updated_at FROM fts_context f JOIN layer2_context c ON c.rowid = f.rowid WHERE fts_context MATCH ? ORDER BY rank LIMIT ?",
      )
      .all(query, limit) as FtsResult[];
  }

  searchArchive(query: string, limit = 10): FtsResult[] {
    return this.db
      .query(
        "SELECT a.id, a.title, a.tags, snippet(fts_archive, 1, '<b>', '</b>', '...', 32) AS snippet, rank, a.created_at, a.updated_at FROM fts_archive f JOIN layer3_archive a ON a.rowid = f.rowid WHERE fts_archive MATCH ? ORDER BY rank LIMIT ?",
      )
      .all(query, limit) as FtsResult[];
  }

  searchShared(query: string, limit = 10): FtsResult[] {
    return this.db
      .query(
        "SELECT s.id, s.category AS title, s.tags, snippet(fts_shared, 1, '<b>', '</b>', '...', 32) AS snippet, rank, s.created_at, s.updated_at FROM fts_shared f JOIN shared_memory s ON s.rowid = f.rowid WHERE fts_shared MATCH ? ORDER BY rank LIMIT ?",
      )
      .all(query, limit) as FtsResult[];
  }

  // ─── Vector Search (sqlite-vec) ────────────────────────────

  upsertEmbedding(id: string, layer: string, embedding: Float32Array): void {
    // vec0 uses INSERT OR REPLACE
    this.db
      .query(
        "INSERT OR REPLACE INTO vec_embeddings (id, layer, embedding) VALUES (?, ?, ?)",
      )
      .run(id, layer, new Uint8Array(embedding.buffer));
  }

  searchEmbeddings(
    embedding: Float32Array,
    limit = 10,
    layer?: string,
  ): VecResult[] {
    const blob = new Uint8Array(embedding.buffer);
    if (layer) {
      return this.db
        .query(
          "SELECT id, layer, distance FROM vec_embeddings WHERE embedding MATCH ? AND layer = ? ORDER BY distance LIMIT ?",
        )
        .all(blob, layer, limit) as VecResult[];
    }
    return this.db
      .query(
        "SELECT id, layer, distance FROM vec_embeddings WHERE embedding MATCH ? ORDER BY distance LIMIT ?",
      )
      .all(blob, limit) as VecResult[];
  }

  deleteEmbedding(id: string): void {
    this.db.query("DELETE FROM vec_embeddings WHERE id = ?").run(id);
  }

  // ─── Chats ─────────────────────────────────────────────────

  createChat(
    id: string,
    title: string,
    model: string,
    source: string = "web",
  ): void {
    this.db
      .query("INSERT INTO chats (id, title, model, source) VALUES (?, ?, ?, ?)")
      .run(id, title, model, source);
  }

  getChat(id: string): ChatRow | null {
    return this.db
      .query("SELECT * FROM chats WHERE id = ?")
      .get(id) as ChatRow | null;
  }

  listChats(limit = 50, source?: string): ChatRow[] {
    if (source) {
      return this.db
        .query(
          "SELECT * FROM chats WHERE source = ? ORDER BY updated_at DESC LIMIT ?",
        )
        .all(source, limit) as ChatRow[];
    }
    return this.db
      .query("SELECT * FROM chats ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as ChatRow[];
  }

  updateChatTitle(id: string, title: string): void {
    this.db
      .query(
        "UPDATE chats SET title = ?, updated_at = unixepoch() WHERE id = ?",
      )
      .run(title, id);
  }

  updateChatTimestamp(id: string): void {
    this.db
      .query("UPDATE chats SET updated_at = unixepoch() WHERE id = ?")
      .run(id);
  }

  deleteChat(id: string): void {
    this.db.query("DELETE FROM chats WHERE id = ?").run(id);
  }

  // ─── Chat Messages ────────────────────────────────────────

  appendChatMessage(
    chatId: string,
    role: string,
    content: string,
    opts?: { reasoning?: string; model?: string; requestId?: string },
  ): number {
    const result = this.db
      .query(
        "INSERT INTO chat_messages (chat_id, role, content, reasoning, model, request_id) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        chatId,
        role,
        content,
        opts?.reasoning ?? null,
        opts?.model ?? null,
        opts?.requestId ?? null,
      );
    this.updateChatTimestamp(chatId);
    return Number(result.lastInsertRowid);
  }

  getChatMessages(chatId: string): ChatMessageRow[] {
    return this.db
      .query("SELECT * FROM chat_messages WHERE chat_id = ? ORDER BY id ASC")
      .all(chatId) as ChatMessageRow[];
  }
}

// ─── Row Types ──────────────────────────────────────────────

export interface ContextRow {
  id: string;
  title: string;
  content: string;
  tags: string;
  derived_from: string;
  agent_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface ArchiveRow {
  id: string;
  title: string;
  content: string;
  tags: string;
  source_request_ids: string;
  confidence: "HIGH" | "LOW";
  agent_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface LogRow {
  id: number;
  request_id: string;
  session_id: string;
  agent_id: string;
  role: string;
  content: string;
  token_count: number | null;
  created_at: number;
}

export interface SharedRow {
  id: string;
  category: string;
  content: string;
  tags: string;
  source: string | null;
  created_at: number;
  updated_at: number;
}

export interface AgentMemRow {
  id: string;
  agent_id: string;
  content: string;
  tags: string;
  created_at: number;
  updated_at: number;
}

export interface FtsResult {
  id: string;
  title: string;
  tags: string;
  snippet: string;
  rank: number;
  created_at: number;
  updated_at: number;
}

export interface VecResult {
  id: string;
  layer: string;
  distance: number;
}

export interface ChatRow {
  id: string;
  title: string;
  model: string;
  source: string;
  created_at: number;
  updated_at: number;
}

export interface ChatMessageRow {
  id: number;
  chat_id: string;
  role: string;
  content: string;
  reasoning: string | null;
  model: string | null;
  request_id: string | null;
  created_at: number;
}
