import { Database } from "bun:sqlite";
import type { AgentMemRow } from "../../types";
import { updateRow } from "../update-row";
import { AGENT_MEM_UPDATABLE } from "./helpers";

/**
 * Latest `agent_memory` row for an agentId (PR B-2). Used by
 * `agent-loop/persist.ts` to load the most recent dynamic-tool blob —
 * keeps SQL out of the pipeline.
 */
export function getLatestAgentMemoryByAgentId(
  db: Database,
  agentId: string,
): AgentMemRow | null {
  return db
    .query(
      "SELECT * FROM agent_memory WHERE agent_id = ? ORDER BY updated_at DESC LIMIT 1",
    )
    .get(agentId) as AgentMemRow | null;
}

/**
 * Update only `content` (and bump `updated_at`) on an existing
 * `agent_memory` row. Identity / tags untouched.
 */
export function updateAgentMemoryContent(
  db: Database,
  id: string,
  content: string,
): void {
  db.query(
    "UPDATE agent_memory SET content = ?, updated_at = unixepoch() WHERE id = ?",
  ).run(content, id);
}

export function insertAgentMemory(
  db: Database,
  id: string,
  agentId: string,
  content: string,
  tags: string,
): void {
  db.query(
    "INSERT INTO agent_memory (id, agent_id, content, tags) VALUES (?, ?, ?, ?)",
  ).run(id, agentId, content, tags);
}

export function getAgentMemories(db: Database, agentId: string): AgentMemRow[] {
  return db
    .query(
      "SELECT * FROM agent_memory WHERE agent_id = ? ORDER BY updated_at DESC",
    )
    .all(agentId) as AgentMemRow[];
}

export function listAllAgentMemories(
  db: Database,
  limit: number,
  offset: number,
  agentId?: string,
): AgentMemRow[] {
  if (agentId) {
    return db
      .query(
        "SELECT * FROM agent_memory WHERE agent_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?",
      )
      .all(agentId, limit, offset) as AgentMemRow[];
  }
  return db
    .query(
      "SELECT * FROM agent_memory ORDER BY updated_at DESC LIMIT ? OFFSET ?",
    )
    .all(limit, offset) as AgentMemRow[];
}

export function countAgentMemories(db: Database, agentId?: string): number {
  if (agentId) {
    const row = db
      .query("SELECT COUNT(*) AS c FROM agent_memory WHERE agent_id = ?")
      .get(agentId) as { c: number };
    return row.c;
  }
  const row = db
    .query("SELECT COUNT(*) AS c FROM agent_memory")
    .get() as { c: number };
  return row.c;
}

export function listAgentIds(db: Database): string[] {
  const rows = db
    .query(
      "SELECT DISTINCT agent_id FROM agent_memory ORDER BY agent_id ASC",
    )
    .all() as { agent_id: string }[];
  return rows.map((r) => r.agent_id);
}

export function getAgentMemory(db: Database, id: string): AgentMemRow | null {
  return db
    .query("SELECT * FROM agent_memory WHERE id = ?")
    .get(id) as AgentMemRow | null;
}

export function updateAgentMemory(
  db: Database,
  id: string,
  fields: { content?: string; tags?: string },
): void {
  updateRow(db, "agent_memory", AGENT_MEM_UPDATABLE, id, fields);
}

export function deleteAgentMemory(db: Database, id: string): void {
  db.query("DELETE FROM agent_memory WHERE id = ?").run(id);
}
