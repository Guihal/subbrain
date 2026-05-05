import type { Database } from "bun:sqlite";
import { sanitizeFtsQuery } from "../../../lib/fts-utils";
import type { FtsResult } from "../../types";
import { buildActiveFilter } from "./helpers";

/**
 * FTS5 search on layer2_context. `activeOnly` (PR 22a / MEM-5) filters by
 * status = 'active'. `notStale` (MEM-6, mig 9) filters superseded/expired.
 * `agentId` (B-1) restricts to caller's own rows + global (NULL); absent →
 * no agent filter (admin scope). Pre-B-1 rows stored without agent_id are
 * NULL → visible to any caller (legacy "shared" back-compat; see B-1
 * leak-window note in docs/02-audit.md).
 *
 * M-03 (mig 13): SELECT `c.salience` for the RAG salience-boost step.
 * M-08: SELECT `c.last_accessed_at, c.access_count` for forgetting curve.
 */
export function searchContext(
  db: Database,
  query: string,
  limit = 10,
  opts?: { activeOnly?: boolean; notStale?: boolean; agentId?: string },
): FtsResult[] {
  const ftsQuery = sanitizeFtsQuery(query);
  if (!ftsQuery) return [];
  const filter = buildActiveFilter("c", opts);
  const agentFilter = opts?.agentId ? " AND (c.agent_id = ? OR c.agent_id IS NULL)" : "";
  const params: (string | number)[] = [ftsQuery];
  if (opts?.agentId) params.push(opts.agentId);
  params.push(limit);
  return db
    .query(
      `SELECT c.id, c.title, c.tags, snippet(fts_context, 1, '<b>', '</b>', '...', 32) AS snippet, rank, c.created_at, c.updated_at, c.salience, c.last_accessed_at, c.access_count FROM fts_context f JOIN layer2_context c ON c.rowid = f.rowid WHERE fts_context MATCH ?${filter}${agentFilter} ORDER BY rank LIMIT ?`,
    )
    .all(...params) as FtsResult[];
}

// M-03 (mig 13): SELECT `a.salience` for RAG salience-boost.
// M-08: SELECT `a.last_accessed_at, a.access_count` for forgetting curve.
export function searchArchive(db: Database, query: string, limit = 10): FtsResult[] {
  const ftsQuery = sanitizeFtsQuery(query);
  if (!ftsQuery) return [];
  return db
    .query(
      "SELECT a.id, a.title, a.tags, snippet(fts_archive, 1, '<b>', '</b>', '...', 32) AS snippet, rank, a.created_at, a.updated_at, a.salience, a.last_accessed_at, a.access_count FROM fts_archive f JOIN layer3_archive a ON a.rowid = f.rowid WHERE fts_archive MATCH ? ORDER BY rank LIMIT ?",
    )
    .all(ftsQuery, limit) as FtsResult[];
}
