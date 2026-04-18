import { Elysia, t } from "elysia";
import type { MemoryDB } from "../db";

/**
 * Logs viewing endpoint for debugging and monitoring.
 *
 * GET /v1/logs              — recent logs across all sessions
 * GET /v1/logs/:sessionId   — logs for a specific session
 * GET /v1/logs/request/:requestId — logs for a specific request
 */
export function logsRoute(memory: MemoryDB) {
  return new Elysia()
    .get(
      "/v1/logs",
      ({ query }) => {
        const limit = Number(query.limit) || 100;
        const afterId = Number(query.after) || 0;
        const roleFilter = query.role || null;

        let rows = memory.getLogsSince(afterId, limit + 50);
        if (roleFilter) {
          rows = rows.filter((r) => r.role === roleFilter);
        }
        rows = rows.slice(0, limit);

        return {
          count: rows.length,
          logs: rows.map((r) => ({
            id: r.id,
            request_id: r.request_id,
            session_id: r.session_id,
            agent_id: r.agent_id,
            role: r.role,
            content:
              r.content.length > 2000
                ? r.content.slice(0, 2000) + "…"
                : r.content,
            token_count: r.token_count,
            created_at: r.created_at,
          })),
        };
      },
      {
        query: t.Object({
          limit: t.Optional(t.String()),
          after: t.Optional(t.String()),
          role: t.Optional(t.String()),
        }),
      },
    )
    .get(
      "/v1/logs/session/:sessionId",
      ({ params, query }) => {
        const limit = Number(query.limit) || 200;
        const rows = memory.getLogsBySession(params.sessionId, limit);

        return {
          session_id: params.sessionId,
          count: rows.length,
          logs: rows.map((r) => ({
            id: r.id,
            request_id: r.request_id,
            agent_id: r.agent_id,
            role: r.role,
            content: r.content,
            token_count: r.token_count,
            created_at: r.created_at,
          })),
        };
      },
      {
        params: t.Object({ sessionId: t.String() }),
        query: t.Object({ limit: t.Optional(t.String()) }),
      },
    )
    .get(
      "/v1/logs/request/:requestId",
      ({ params }) => {
        const rows = memory.getLogsByRequest(params.requestId);

        return {
          request_id: params.requestId,
          count: rows.length,
          logs: rows.map((r) => ({
            id: r.id,
            session_id: r.session_id,
            agent_id: r.agent_id,
            role: r.role,
            content: r.content,
            token_count: r.token_count,
            created_at: r.created_at,
          })),
        };
      },
      {
        params: t.Object({ requestId: t.String() }),
      },
    )
    .get("/v1/logs/stats", () => {
      // Count totals per role
      const stats = memory.db
        .query(
          `SELECT role, COUNT(*) as count, 
           SUM(token_count) as total_tokens,
           MIN(created_at) as first_at,
           MAX(created_at) as last_at
           FROM layer4_log GROUP BY role ORDER BY count DESC`,
        )
        .all() as {
        role: string;
        count: number;
        total_tokens: number | null;
        first_at: string;
        last_at: string;
      }[];

      const sessions = memory.db
        .query("SELECT COUNT(DISTINCT session_id) as count FROM layer4_log")
        .get() as { count: number };

      const requests = memory.db
        .query(
          "SELECT COUNT(DISTINCT request_id) as count FROM layer4_log WHERE request_id != 'system'",
        )
        .get() as { count: number };

      return {
        total_sessions: sessions.count,
        total_requests: requests.count,
        by_role: stats,
      };
    });
}
