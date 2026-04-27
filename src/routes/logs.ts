import { Elysia, t } from "elysia";
import type { MemoryDB } from "../db";
import { maskSecrets } from "../lib/redact";

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
        const raw = query.raw === "1";

        let rows = memory.getLogsSince(afterId, limit + 50);
        if (roleFilter) {
          rows = rows.filter((r) => r.role === roleFilter);
        }
        rows = rows.slice(0, limit);

        return {
          count: rows.length,
          logs: rows.map((r) => {
            let content =
              r.content.length > 2000
                ? r.content.slice(0, 2000) + "…"
                : r.content;
            if (!raw) content = maskSecrets(content);
            return {
              id: r.id,
              request_id: r.request_id,
              session_id: r.session_id,
              agent_id: r.agent_id,
              role: r.role,
              content,
              token_count: r.token_count,
              created_at: r.created_at,
            };
          }),
        };
      },
      {
        query: t.Object({
          limit: t.Optional(t.String()),
          after: t.Optional(t.String()),
          role: t.Optional(t.String()),
          raw: t.Optional(t.String()),
        }),
      },
    )
    .get(
      "/v1/logs/session/:sessionId",
      ({ params, query }) => {
        const limit = Number(query.limit) || 200;
        const raw = query.raw === "1";
        const rows = memory.getLogsBySession(params.sessionId, limit);

        return {
          session_id: params.sessionId,
          count: rows.length,
          logs: rows.map((r) => ({
            id: r.id,
            request_id: r.request_id,
            agent_id: r.agent_id,
            role: r.role,
            content: raw ? r.content : maskSecrets(r.content),
            token_count: r.token_count,
            created_at: r.created_at,
          })),
        };
      },
      {
        params: t.Object({ sessionId: t.String() }),
        query: t.Object({ limit: t.Optional(t.String()), raw: t.Optional(t.String()) }),
      },
    )
    .get(
      "/v1/logs/request/:requestId",
      ({ params, query }) => {
        const raw = query.raw === "1";
        const rows = memory.getLogsByRequest(params.requestId);

        return {
          request_id: params.requestId,
          count: rows.length,
          logs: rows.map((r) => ({
            id: r.id,
            session_id: r.session_id,
            agent_id: r.agent_id,
            role: r.role,
            content: raw ? r.content : maskSecrets(r.content),
            token_count: r.token_count,
            created_at: r.created_at,
          })),
        };
      },
      {
        params: t.Object({ requestId: t.String() }),
        query: t.Object({ raw: t.Optional(t.String()) }),
      },
    )
    .get("/v1/logs/stats", () => {
      // W2-1: SQL moved into LogRepository; route stays in view layer.
      return {
        total_sessions: memory.logRepo.countDistinctSessions(),
        total_requests: memory.logRepo.countDistinctRequests(),
        by_role: memory.logRepo.statsByRole(),
      };
    });
}
