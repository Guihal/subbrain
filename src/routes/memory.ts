/**
 * Memory admin routes — HTTP surface for the web UI /memory page.
 *
 * Covers all memory layers: layer1_focus (KV), shared_memory, layer2_context,
 * layer3_archive, agent_memory, layer4_log (read-only). All endpoints are
 * registered after authMiddleware in src/index.ts.
 *
 * List endpoints return `{ items, total }` so the UI can paginate without a
 * second request. `?q=` delegates to the FTS5 helpers on MemoryDB (which
 * internally call sanitizeFtsQuery).
 */
import { Elysia, t } from "elysia";
import type { MemoryDB } from "../db";

function notFound(what: string): Response {
  return new Response(
    JSON.stringify({ error: { message: `${what} not found` } }),
    { status: 404, headers: { "Content-Type": "application/json" } },
  );
}

export function memoryRoute(memory: MemoryDB) {
  return (
    new Elysia({ prefix: "/v1/memory" })
      // ─── Layer 1: Focus (KV) ────────────────────────────────
      .get("/focus", () => memory.getAllFocus())
      .put(
        "/focus/:key",
        ({ params, body }) => {
          memory.setFocus(params.key, body.value);
          return { key: params.key, value: body.value };
        },
        { body: t.Object({ value: t.String() }) },
      )
      .delete("/focus/:key", ({ params }) => {
        memory.deleteFocus(params.key);
        return { ok: true };
      })

      // ─── Shared Memory ─────────────────────────────────────
      .get("/shared", ({ query }) => {
        const limit = Number(query.limit) || 50;
        const offset = Number(query.offset) || 0;
        const category =
          typeof query.category === "string" && query.category.length > 0
            ? query.category
            : undefined;
        const q =
          typeof query.q === "string" && query.q.trim().length > 0
            ? query.q.trim()
            : undefined;
        if (q) {
          // FTS returns sparse FtsResult; rehydrate to full rows so the UI
          // editor has `content` / `category` / `source` / etc.
          const hits = memory.searchShared(q, limit);
          const items = hits
            .map((h) => memory.getShared(h.id))
            .filter((r): r is NonNullable<typeof r> => r !== null);
          return { items, total: items.length };
        }
        return {
          items: memory.listShared(limit, offset, category),
          total: memory.countShared(category),
        };
      })
      .patch(
        "/shared/:id",
        ({ params, body }) => {
          const row = memory.getShared(params.id);
          if (!row) return notFound("Shared entry");
          memory.updateShared(params.id, body);
          return memory.getShared(params.id);
        },
        {
          body: t.Object({
            category: t.Optional(t.String()),
            content: t.Optional(t.String()),
            tags: t.Optional(t.String()),
          }),
        },
      )
      .delete("/shared/:id", ({ params }) => {
        const row = memory.getShared(params.id);
        if (!row) return notFound("Shared entry");
        memory.deleteShared(params.id);
        return { ok: true };
      })

      // ─── Layer 2: Context ──────────────────────────────────
      .get("/context", ({ query }) => {
        const limit = Number(query.limit) || 50;
        const offset = Number(query.offset) || 0;
        const q =
          typeof query.q === "string" && query.q.trim().length > 0
            ? query.q.trim()
            : undefined;
        if (q) {
          const hits = memory.searchContext(q, limit);
          const items = hits
            .map((h) => memory.getContext(h.id))
            .filter((r): r is NonNullable<typeof r> => r !== null);
          return { items, total: items.length };
        }
        return {
          items: memory.listContext(limit, offset),
          total: memory.countContext(),
        };
      })
      .patch(
        "/context/:id",
        ({ params, body }) => {
          const row = memory.getContext(params.id);
          if (!row) return notFound("Context entry");
          memory.updateContext(params.id, body);
          return memory.getContext(params.id);
        },
        {
          body: t.Object({
            title: t.Optional(t.String()),
            content: t.Optional(t.String()),
            tags: t.Optional(t.String()),
          }),
        },
      )
      .delete("/context/:id", ({ params }) => {
        const row = memory.getContext(params.id);
        if (!row) return notFound("Context entry");
        memory.deleteContext(params.id);
        return { ok: true };
      })

      // ─── Layer 3: Archive ──────────────────────────────────
      .get("/archive", ({ query }) => {
        const limit = Number(query.limit) || 50;
        const offset = Number(query.offset) || 0;
        const q =
          typeof query.q === "string" && query.q.trim().length > 0
            ? query.q.trim()
            : undefined;
        if (q) {
          const hits = memory.searchArchive(q, limit);
          const items = hits
            .map((h) => memory.getArchive(h.id))
            .filter((r): r is NonNullable<typeof r> => r !== null);
          return { items, total: items.length };
        }
        return {
          items: memory.listArchive(limit, offset),
          total: memory.countArchive(),
        };
      })
      .patch(
        "/archive/:id",
        ({ params, body }) => {
          const row = memory.getArchive(params.id);
          if (!row) return notFound("Archive entry");
          memory.updateArchive(params.id, body);
          return memory.getArchive(params.id);
        },
        {
          body: t.Object({
            title: t.Optional(t.String()),
            content: t.Optional(t.String()),
            tags: t.Optional(t.String()),
            confidence: t.Optional(
              t.Union([t.Literal("HIGH"), t.Literal("LOW")]),
            ),
          }),
        },
      )
      .delete("/archive/:id", ({ params }) => {
        const row = memory.getArchive(params.id);
        if (!row) return notFound("Archive entry");
        memory.deleteArchive(params.id);
        return { ok: true };
      })

      // ─── Agent Memory ──────────────────────────────────────
      .get("/agent/agents", () => memory.listAgentIds())
      .get("/agent", ({ query }) => {
        const limit = Number(query.limit) || 50;
        const offset = Number(query.offset) || 0;
        const agentId =
          typeof query.agent_id === "string" && query.agent_id.length > 0
            ? query.agent_id
            : undefined;
        return {
          items: memory.listAllAgentMemories(limit, offset, agentId),
          total: memory.countAgentMemories(agentId),
        };
      })
      .patch(
        "/agent/:id",
        ({ params, body }) => {
          const row = memory.getAgentMemory(params.id);
          if (!row) return notFound("Agent memory entry");
          memory.updateAgentMemory(params.id, body);
          return memory.getAgentMemory(params.id);
        },
        {
          body: t.Object({
            content: t.Optional(t.String()),
            tags: t.Optional(t.String()),
          }),
        },
      )
      .delete("/agent/:id", ({ params }) => {
        const row = memory.getAgentMemory(params.id);
        if (!row) return notFound("Agent memory entry");
        memory.deleteAgentMemory(params.id);
        return { ok: true };
      })

      // ─── Layer 4: Log (read-only) ──────────────────────────
      .get("/log/sessions", ({ query }) => {
        const limit = Number(query.limit) || 50;
        return memory.listLogSessions(limit);
      })
      .get("/log", ({ query }) => {
        const limit = Number(query.limit) || 100;
        const offset = Number(query.offset) || 0;
        const sessionId =
          typeof query.session_id === "string" && query.session_id.length > 0
            ? query.session_id
            : undefined;
        return {
          items: memory.listLog(limit, offset, sessionId),
          total: memory.countLog(sessionId),
        };
      })
  );
}
