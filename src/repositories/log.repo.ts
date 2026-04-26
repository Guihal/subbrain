/**
 * LogRepository — PR 27 (LAYER-5). Wraps `LogsTable` (Layer-4 raw_log) and,
 * since M-04 (mig 11), `LogTable` for FTS5-backed episodic search.
 */
import { Database } from "bun:sqlite";
import { LogsTable } from "../db/tables/logs";
import { LogTable, type SearchLogOpts } from "../db/tables/log";
import type { FtsResult, LogRow } from "../db/types";

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
  searchLog = (query: string, opts?: SearchLogOpts): FtsResult[] =>
    this.fts.searchLog(query, opts);
}
