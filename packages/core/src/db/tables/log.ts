/**
 * LogTable (M-04 / M-04.1): FTS5-backed episodic search over Layer 4
 * (`layer4_log`) + rolling N-row vec embedding window in `vec_embeddings`
 * (layer='log').
 *
 * Mirror table `fts_log` (mig 11) is kept in sync via AFTER INSERT/DELETE/UPDATE
 * triggers on `layer4_log`. This class owns the read path:
 * `searchLog(query, opts)` returns `FtsResult[]` shaped like the other FTS
 * helpers so it plugs into the RAG pipeline alongside them.
 *
 * M-04.1: rolling embed support — `selectUnembeddedRecent` finds the most
 * recent log rows without a `vec_embeddings(layer='log')` row, and
 * `evictOldestLogEmbeddings` keeps the window bounded by deleting the
 * oldest-by-`layer4_log.created_at` rows beyond the cap. Both raw SQL stays
 * here (db/tables = source of truth per PR 27 layer boundary).
 *
 * Privacy: raw log rows hold pre-scrub user input. Public REST does not
 * expose this — the only callers should be MCP `agent-only` scope and the
 * RAG pipeline when `layers` explicitly includes `"log"` (default omits it).
 */
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { sanitizeFtsQuery } from "../../lib/fts-utils";
import type { FtsResult, LogStatsRow } from "../types";

/** M-04.1: row shape returned by `selectUnembeddedRecent`. */
export interface UnembeddedLogRow {
  id: string;
  content: string;
  role: string;
}

/** M-04.1: row shape for batch hydration in the RAG vec branch. */
export interface LogVecHydrateRow {
  id: string;
  role: string;
  content: string;
  created_at: number;
}

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

  /**
   * M-04.1: most recent `layer4_log` rows that don't yet have a row in
   * `vec_embeddings` with layer='log'. `id` is stringified to match the
   * shared embedding API (which keys on TEXT id).
   *
   * The night-cycle `embed-log` step calls this with a per-tick budget so
   * `LIMIT` caps how many embed calls go out per cycle (rolling-window
   * incremental fill). Initial backfill = first cycle drains up to the
   * window cap (default 10k).
   */
  selectUnembeddedRecent(limit: number): UnembeddedLogRow[] {
    return this.db
      .query<{ id: string; content: string; role: string }, [number]>(
        `SELECT CAST(l.id AS TEXT) AS id, l.content AS content, l.role AS role
           FROM layer4_log l
          WHERE l.id NOT IN (
                  SELECT CAST(id AS INTEGER) FROM vec_embeddings WHERE layer='log'
                )
          ORDER BY l.created_at DESC, l.id DESC
          LIMIT ?`,
      )
      .all(limit);
  }

  /** M-04.1: count of vec_embeddings rows with layer='log' (for cap math). */
  countLogEmbeddings(): number {
    const row = this.db
      .query<{ c: number }, []>("SELECT count(*) AS c FROM vec_embeddings WHERE layer='log'")
      .get();
    return row?.c ?? 0;
  }

  /**
   * M-04.1: drop the N oldest log embeddings (oldest = smallest
   * `layer4_log.created_at`, tie-break by id). Returns rows actually deleted.
   * `n <= 0` is a no-op (returns 0).
   *
   * The `JOIN` filters out orphan `vec_embeddings` rows whose `layer4_log`
   * parent already vanished — those are cleaned up by the same query (the
   * inner SELECT only matches existing parents, so orphans linger; explicit
   * orphan cleanup is out of scope for the rolling-cap step).
   */
  /**
   * M-04.1: batch-hydrate log rows for the RAG vec branch. `ids` are
   * stringified integers (matches `FtsResult.id` shape and `vec_embeddings.id`).
   * Returns rows keyed by stringified id; missing ids are simply absent.
   */
  hydrateForVec(ids: string[]): LogVecHydrateRow[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    return this.db
      .query<LogVecHydrateRow, string[]>(
        `SELECT CAST(id AS TEXT) AS id, role, content, created_at
           FROM layer4_log
          WHERE id IN (${placeholders})`,
      )
      .all(...ids);
  }

  evictOldestLogEmbeddings(n: number): number {
    if (n <= 0) return 0;
    // `vec_embeddings` is a sqlite-vec virtual table whose DELETE reports an
    // inflated `result.changes` (observed: returns ~2× actual deletions in
    // bun:sqlite). Diff `count(*)` before/after instead — accurate, single
    // extra round-trip.
    const before = this.countLogEmbeddings();
    this.db
      .query(
        `DELETE FROM vec_embeddings
          WHERE layer='log'
            AND id IN (
                  SELECT v.id
                    FROM vec_embeddings v
                    JOIN layer4_log l ON CAST(l.id AS TEXT) = v.id
                   WHERE v.layer='log'
                ORDER BY l.created_at ASC, l.id ASC
                   LIMIT ?
                )`,
      )
      .run(n);
    const after = this.countLogEmbeddings();
    return Math.max(0, before - after);
  }

  // W2-1: aggregates for `/v1/logs/stats` — moved out of the route per SoC.
  statsByRole(): LogStatsRow[] {
    return this.db
      .query<LogStatsRow, []>(
        `SELECT role, COUNT(*) as count,
                SUM(token_count) as total_tokens,
                MIN(created_at) as first_at,
                MAX(created_at) as last_at
           FROM layer4_log GROUP BY role ORDER BY count DESC`,
      )
      .all();
  }

  countDistinctSessions(): number {
    const row = this.db
      .query<{ count: number }, []>("SELECT COUNT(DISTINCT session_id) as count FROM layer4_log")
      .get();
    return row?.count ?? 0;
  }

  // 'system' is the synthetic bucket for non-request-scoped writes.
  countDistinctRequests(): number {
    const row = this.db
      .query<{ count: number }, []>(
        "SELECT COUNT(DISTINCT request_id) as count FROM layer4_log WHERE request_id != 'system'",
      )
      .get();
    return row?.count ?? 0;
  }
}
