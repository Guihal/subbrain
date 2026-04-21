/**
 * Memory admin routes — HTTP surface for the web UI /memory page.
 *
 * Covers all memory layers: layer1_focus (KV), shared_memory, layer2_context,
 * layer3_archive, agent_memory, layer4_log (read-only). All endpoints are
 * registered after authMiddleware in src/app/bootstrap.ts.
 *
 * List endpoints return a `PaginatedResponse<T>`-compatible `{items, total,
 * page, page_size}` envelope (see `src/lib/api-envelope.ts`). `?q=`
 * delegates to the FTS5 helpers on MemoryDB (which internally call
 * sanitizeFtsQuery); FTS hits are rehydrated to full rows before returning.
 */
import { Elysia, t } from "elysia";
import type { MemoryDB } from "../db";
import { paginate } from "../lib/api-envelope";
import { NotFoundError } from "../lib/errors";

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
        const category =
          typeof query.category === "string" && query.category.length > 0
            ? query.category
            : undefined;
        return paginate(
          (limit, offset, q) => {
            if (q) {
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
          },
          query,
        );
      })
      .patch(
        "/shared/:id",
        ({ params, body }) => {
          const row = memory.getShared(params.id);
          if (!row) throw new NotFoundError("Shared entry");
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
        if (!row) throw new NotFoundError("Shared entry");
        memory.deleteShared(params.id);
        return { ok: true };
      })

      // ─── Layer 2: Context ──────────────────────────────────
      .get("/context", ({ query }) =>
        paginate(
          (limit, offset, q) => {
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
          },
          query,
        ),
      )
      .patch(
        "/context/:id",
        ({ params, body }) => {
          const row = memory.getContext(params.id);
          if (!row) throw new NotFoundError("Context entry");
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
        if (!row) throw new NotFoundError("Context entry");
        memory.deleteContext(params.id);
        return { ok: true };
      })

      // ─── Layer 3: Archive ──────────────────────────────────
      .get("/archive", ({ query }) =>
        paginate(
          (limit, offset, q) => {
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
          },
          query,
        ),
      )
      .patch(
        "/archive/:id",
        ({ params, body }) => {
          const row = memory.getArchive(params.id);
          if (!row) throw new NotFoundError("Archive entry");
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
        if (!row) throw new NotFoundError("Archive entry");
        memory.deleteArchive(params.id);
        return { ok: true };
      })

      // ─── Agent Memory ──────────────────────────────────────
      .get("/agent/agents", () => memory.listAgentIds())
      .get("/agent", ({ query }) => {
        const agentId =
          typeof query.agent_id === "string" && query.agent_id.length > 0
            ? query.agent_id
            : undefined;
        return paginate(
          (limit, offset) => ({
            items: memory.listAllAgentMemories(limit, offset, agentId),
            total: memory.countAgentMemories(agentId),
          }),
          query,
        );
      })
      .patch(
        "/agent/:id",
        ({ params, body }) => {
          const row = memory.getAgentMemory(params.id);
          if (!row) throw new NotFoundError("Agent memory entry");
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
        if (!row) throw new NotFoundError("Agent memory entry");
        memory.deleteAgentMemory(params.id);
        return { ok: true };
      })

      // ─── Layer 4: Log (read-only) ──────────────────────────
      .get("/log/sessions", ({ query }) => {
        const limit = Number(query.limit) || 50;
        return memory.listLogSessions(limit);
      })
      .get("/log", ({ query }) => {
        const sessionId =
          typeof query.session_id === "string" && query.session_id.length > 0
            ? query.session_id
            : undefined;
        return paginate(
          (limit, offset) => ({
            items: memory.listLog(limit, offset, sessionId),
            total: memory.countLog(sessionId),
          }),
          query,
        );
      })
  );
}
