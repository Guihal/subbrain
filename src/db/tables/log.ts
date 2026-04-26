/**
 * LogTable (M-04): FTS5-backed episodic search over Layer 4 (`layer4_log`).
 *
 * Mirror table `fts_log` (mig 11) is kept in sync via AFTER INSERT/DELETE/UPDATE
 * triggers on `layer4_log`. This class only owns the read path: a
 * `searchLog(query, opts)` that returns `FtsResult[]` shaped like the other
 * FTS helpers (`searchContext`, `searchArchive`, `searchShared`) so it can
 * plug into the RAG pipeline alongside them.
 *
 * Privacy: raw log rows hold pre-scrub user input. Public REST does not
 * expose this — the only callers should be MCP `agent-only` scope and the
 * RAG pipeline when `layers` explicitly includes `"log"` (default omits it).
 *
 * No vec embeddings on Layer 4 in this PR (M-04.1 follow-up).
 */
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { sanitizeFtsQuery } from "../../lib/fts-utils";
import type { FtsResult } from "../types";

export interface SearchLogOpts {
  /** Max rows returned (default 20). */
  limit?: number;
  /** Restrict to a single agent's rows. */
  agentId?: string;
  /** Restrict to a single session's rows. */
  sessionId?: string;
}

export class LogTable {
  constructor(public readonly db: Database) {}

  /**
   * FTS5 search over `layer4_log.content` + `role`.
   *
   * Sanitization: `sanitizeFtsQuery` strips raw `:`, `*`, `"` and stop words
   * before MATCH — required, raw user input throws at query time. Empty
   * sanitized result → empty result set (no MATCH against `""`).
   *
   * `id` in returned `FtsResult` is the stringified `layer4_log.id` (number)
   * so the shape matches sibling FTS helpers and the RAG pipeline can
   * dedupe across layers without a special case.
   */
  searchLog(rawQuery: string, opts: SearchLogOpts = {}): FtsResult[] {
    const sanitized = sanitizeFtsQuery(rawQuery);
    if (!sanitized) return [];
    const limit = opts.limit ?? 20;

    let sql = `
      SELECT CAST(l.id AS TEXT)              AS id,
             l.role                          AS title,
             ''                              AS tags,
             snippet(fts_log, 1, '<b>', '</b>', '...', 32) AS snippet,
             rank,
             l.created_at                    AS created_at,
             l.created_at                    AS updated_at
        FROM fts_log
        JOIN layer4_log l ON l.id = fts_log.rowid
       WHERE fts_log MATCH ?
    `;
    const params: SQLQueryBindings[] = [sanitized];
    if (opts.agentId) {
      sql += " AND l.agent_id = ?";
      params.push(opts.agentId);
    }
    if (opts.sessionId) {
      sql += " AND l.session_id = ?";
      params.push(opts.sessionId);
    }
    sql += " ORDER BY rank LIMIT ?";
    params.push(limit);
    return this.db.query(sql).all(...params) as FtsResult[];
  }
}
