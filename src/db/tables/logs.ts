import { Database } from "bun:sqlite";
import type { LogRow } from "../types";

export class LogsTable {
  constructor(public readonly db: Database) {}

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
      .query("SELECT * FROM layer4_log WHERE session_id = ? ORDER BY id DESC LIMIT ?")
      .all(sessionId, limit) as LogRow[];
  }

  getLogsSince(afterId: number, limit = 500): LogRow[] {
    return this.db
      .query("SELECT * FROM layer4_log WHERE id > ? ORDER BY id ASC LIMIT ?")
      .all(afterId, limit) as LogRow[];
  }

  getLogsSinceTime(sinceUnix: number, limit = 500): LogRow[] {
    return this.db
      .query(
        "SELECT * FROM layer4_log WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?",
      )
      .all(sinceUnix, limit) as LogRow[];
  }

  listLog(limit = 100, offset = 0, sessionId?: string): LogRow[] {
    if (sessionId) {
      return this.db
        .query(
          "SELECT * FROM layer4_log WHERE session_id = ? ORDER BY id DESC LIMIT ? OFFSET ?",
        )
        .all(sessionId, limit, offset) as LogRow[];
    }
    return this.db
      .query("SELECT * FROM layer4_log ORDER BY id DESC LIMIT ? OFFSET ?")
      .all(limit, offset) as LogRow[];
  }

  countLog(sessionId?: string): number {
    if (sessionId) {
      const row = this.db
        .query("SELECT COUNT(*) AS c FROM layer4_log WHERE session_id = ?")
        .get(sessionId) as { c: number };
      return row.c;
    }
    const row = this.db.query("SELECT COUNT(*) AS c FROM layer4_log").get() as { c: number };
    return row.c;
  }

  listLogSessions(limit = 50): string[] {
    const rows = this.db
      .query(
        "SELECT session_id, MAX(id) AS last_id FROM layer4_log GROUP BY session_id ORDER BY last_id DESC LIMIT ?",
      )
      .all(limit) as { session_id: string }[];
    return rows.map((r) => r.session_id);
  }

  groupLogsBySession(rows: LogRow[]): Map<string, LogRow[]> {
    const groups = new Map<string, LogRow[]>();
    for (const row of rows) {
      const arr = groups.get(row.session_id) || [];
      arr.push(row);
      groups.set(row.session_id, arr);
    }
    return groups;
  }
}
