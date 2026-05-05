/**
 * LogRepository — PR 27 (LAYER-5). Wraps `LogsTable` (Layer-4 raw_log) and,
 * since M-04 (mig 11), `LogTable` for FTS5-backed episodic search.
 */
import type { Database } from "bun:sqlite";
import type { FtsResult, LogRow, LogStatsRow } from "../db/index";
import {
  LogTable,
  type LogVecHydrateRow,
  type SearchLogOpts,
  type UnembeddedLogRow,
} from "../db/tables/log";
import { LogsTable } from "../db/tables/logs";

export class LogRepository {
  private readonly logs: LogsTable;
  private readonly fts: LogTable;

  constructor(db: Database) {
    this.logs = new LogsTable(db);
    this.fts = new LogTable(db);
  }

  appendLog = (
    requestId: string,
    sessionId: string,
    agentId: string,
    role: string,
    content: string,
    tokenCount?: number,
  ): number => this.logs.appendLog(requestId, sessionId, agentId, role, content, tokenCount);

  getLogsByRequest = (requestId: string): LogRow[] => this.logs.getLogsByRequest(requestId);
  getLogsBySession = (sessionId: string, limit?: number): LogRow[] =>
    this.logs.getLogsBySession(sessionId, limit);
  getLogsSince = (afterId: number, limit?: number): LogRow[] =>
    this.logs.getLogsSince(afterId, limit);
  getLogsSinceTime = (sinceUnix: number, limit?: number): LogRow[] =>
    this.logs.getLogsSinceTime(sinceUnix, limit);
  listLog = (limit?: number, offset?: number, sessionId?: string): LogRow[] =>
    this.logs.listLog(limit, offset, sessionId);
  countLog = (sessionId?: string): number => this.logs.countLog(sessionId);
  listLogSessions = (limit?: number): string[] => this.logs.listLogSessions(limit);
  groupLogsBySession = (rows: LogRow[]): Map<string, LogRow[]> =>
    this.logs.groupLogsBySession(rows);

  /**
   * M-04: FTS5 search over `layer4_log.content` + `role`. Agent-only —
   * raw logs hold pre-scrub PII, so no public REST exposure. Used by the
   * `memory_log_search` MCP tool and the RAG pipeline `layers: ["log"]`
   * branch.
   */
  searchLog = (query: string, opts?: SearchLogOpts): FtsResult[] => this.fts.searchLog(query, opts);

  /**
   * M-04.1: pass-through for the night-cycle `embed-log` step. Returns the
   * most recent `layer4_log` rows missing from `vec_embeddings(layer='log')`,
   * up to `limit`. Used as the rolling-window incremental fill source.
   */
  selectUnembeddedRecent = (limit: number): UnembeddedLogRow[] =>
    this.fts.selectUnembeddedRecent(limit);

  /** M-04.1: pass-through. Used by the embed-log step's cap math. */
  countLogEmbeddings = (): number => this.fts.countLogEmbeddings();

  /** M-04.1: pass-through. Drops `n` oldest log embeddings (rolling-cap). */
  evictOldestLogEmbeddings = (n: number): number => this.fts.evictOldestLogEmbeddings(n);

  /** M-04.1: batch-hydrate log rows by id for the RAG vec branch. */
  hydrateForVec = (ids: string[]): LogVecHydrateRow[] => this.fts.hydrateForVec(ids);

  /** W2-1: per-role aggregates for the `/v1/logs/stats` admin endpoint. */
  statsByRole = (): LogStatsRow[] => this.fts.statsByRole();

  /** W2-1: distinct session count across all log rows. */
  countDistinctSessions = (): number => this.fts.countDistinctSessions();

  /** W2-1: distinct request count, excluding the synthetic 'system' bucket. */
  countDistinctRequests = (): number => this.fts.countDistinctRequests();
}
