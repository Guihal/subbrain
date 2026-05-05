import type { MemoryDB } from "../../db";
import { sanitizeFtsQuery } from "../../lib/fts-utils";
import type { RAGResult } from "../types";

/**
 * FTS5-only search (no RPM cost, fast).
 *
 * B-1: `agentId` (when set) restricts context hits to caller's private rows
 * + global (NULL) rows. Archive + shared ignore the filter (both are
 * by-design global; see searchShared comment in db/tables/shared.ts and
 * MEM-3 spec).
 *
 * M-04: `"log"` layer (when included) joins fts_log → layer4_log via rowid.
 * FTS-only (no vec branch — see RAGPipeline.search). `sessionId` filters
 * log rows by session; `agentId` filters by agent_id (NOT NULL on log rows,
 * so unlike context/archive/shared this is a hard equality match).
 */
export function ftsSearch(
  memory: MemoryDB,
  query: string,
  layers: string[],
  limit: number,
  agentId?: string,
  sessionId?: string,
): RAGResult[] {
  const ftsQuery = sanitizeFtsQuery(query);
  if (!ftsQuery) return [];

  const results: RAGResult[] = [];

  // MEM-5 (PR 22a): RAG injection must see only approved ('active') facts;
  // pending / rejected rows are filtered at SQL level inside searchContext /
  // searchShared. Archive has no status column — unchanged.
  if (layers.includes("context")) {
    for (const r of memory.searchContext(ftsQuery, limit, {
      activeOnly: true,
      notStale: true,
      agentId,
    })) {
      results.push({
        id: r.id,
        layer: "context",
        title: r.title,
        snippet: r.snippet,
        score: 0,
        created_at: r.created_at,
        updated_at: r.updated_at,
        // M-03: salience threaded through SELECT for the post-rerank
        // salience-boost step.
        salience: r.salience,
        // M-08: access columns threaded for the forgetting-curve step.
        last_accessed_at: r.last_accessed_at,
        access_count: r.access_count,
      });
    }
  }
  if (layers.includes("archive")) {
    for (const r of memory.searchArchive(ftsQuery, limit)) {
      results.push({
        id: r.id,
        layer: "archive",
        title: r.title,
        snippet: r.snippet,
        score: 0,
        created_at: r.created_at,
        updated_at: r.updated_at,
        salience: r.salience,
        last_accessed_at: r.last_accessed_at,
        access_count: r.access_count,
      });
    }
  }
  if (layers.includes("shared")) {
    for (const r of memory.searchShared(ftsQuery, limit, { activeOnly: true, notStale: true })) {
      results.push({
        id: r.id,
        layer: "shared",
        title: r.title,
        snippet: r.snippet,
        score: 0,
        created_at: r.created_at,
        updated_at: r.updated_at,
        // M-07: kind threaded through the SELECT in SharedTable.searchShared.
        kind: r.kind,
        salience: r.salience,
        last_accessed_at: r.last_accessed_at,
        access_count: r.access_count,
      });
    }
  }
  if (layers.includes("log")) {
    // Pass already-sanitized `ftsQuery` (single source of truth, matches
    // other layers above). searchLog re-sanitizes internally — idempotent
    // on the safe form, kept for direct callers.
    for (const r of memory.logRepo.searchLog(ftsQuery, { limit, agentId, sessionId })) {
      results.push({
        id: r.id,
        layer: "log",
        title: r.title,
        snippet: r.snippet,
        score: 0,
        created_at: r.created_at,
        updated_at: r.updated_at,
      });
    }
  }

  return results;
}
