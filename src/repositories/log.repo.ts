/**
 * LogRepository — PR 27 (LAYER-5). Wraps `LogsTable` (Layer-4 raw_log).
 */
import { Database } from "bun:sqlite";
import { LogsTable } from "../db/tables/logs";
import type { LogRow } from "../db/types";

export class LogRepository {
  private readonly logs: LogsTable;

  constructor(db: Database) {
    this.logs = new LogsTable(db);
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
}
