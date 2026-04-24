/**
 * Memory admin routes — HTTP surface for /memory UI. Covers focus, shared,
 * layer2_context, layer3_archive, agent, layer4_log (ro), plus PR 22b pending
 * approval. List endpoints return {items,total,page,page_size} via paginate().
 * FTS hits are rehydrated to full rows via getShared/getContext/getArchive.
 * Mounted after authMiddleware in src/app/bootstrap.ts.
 */
import { Elysia, t } from "elysia";
import type { MemoryDB, SharedRow, ContextRow } from "../db";
import { paginate } from "../lib/api-envelope";
import { NotFoundError } from "../lib/errors";
import type { MemoryService } from "../services/memory.service";
import type { MemoryStatus } from "../db";

// ─── PR 22b helpers: pending approval ────────────────────────
type AppLayer = "shared" | "context";
const TABLE: Record<AppLayer, string> = {
  shared: "shared_memory",
  context: "layer2_context",
};

function loadPending(
  memory: MemoryDB,
  layer: AppLayer,
  limit: number,
  offset: number,
): { items: (SharedRow | ContextRow)[]; total: number } {
  const t = TABLE[layer];
  const items = memory.db
    .query(`SELECT * FROM ${t} WHERE status = 'pending' ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
    .all(limit, offset) as (SharedRow | ContextRow)[];
  const total = (
    memory.db.query(`SELECT COUNT(*) AS c FROM ${t} WHERE status = 'pending'`).get() as { c: number }
  ).c;
  return { items, total };
}

function patchStatus(memory: MemoryDB, layer: AppLayer, id: string, status: "active" | "rejected") {
  if (layer === "shared") {
    if (!memory.getShared(id)) throw new NotFoundError("Shared entry");
    memory.updateShared(id, { status });
    return memory.getShared(id)!;
  }
  if (!memory.getContext(id)) throw new NotFoundError("Context entry");
  memory.updateContext(id, { status });
  return memory.getContext(id)!;
}

const LAYER_LIT = t.Union([t.Literal("shared"), t.Literal("context")]);
const INT_LIKE = t.Optional(t.Union([t.String(), t.Number()]));
const PENDING_QUERY = t.Object({
  layer: LAYER_LIT,
  page: INT_LIKE,
  page_size: INT_LIKE,
  limit: INT_LIKE,
  offset: INT_LIKE,
});
const STATUS_PARAMS = t.Object({ layer: LAYER_LIT, id: t.String() });
const STATUS_BODY = t.Object({
  status: t.Union([t.Literal("active"), t.Literal("rejected")]),
});

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

const bodies = {
  shared: t.Object({
    category: t.Optional(t.String()),
    content: t.Optional(t.String()),
    tags: t.Optional(t.String()),
  }),
  context: t.Object({
    title: t.Optional(t.String()),
    content: t.Optional(t.String()),
    tags: t.Optional(t.String()),
  }),
  archive: t.Object({
    title: t.Optional(t.String()),
    content: t.Optional(t.String()),
    tags: t.Optional(t.String()),
    confidence: t.Optional(t.Union([t.Literal("HIGH"), t.Literal("LOW")])),
  }),
  agent: t.Object({
    content: t.Optional(t.String()),
    tags: t.Optional(t.String()),
  }),
};

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

      // ─── PR 22b: Pending approval (shared + context only) ──
      // Route to facade update* → updateRow() with status whitelisted via
      // SHARED_UPDATABLE / CONTEXT_UPDATABLE (PR 22a). 404 missing / 422 bad layer.
      .get(
        "/pending",
        ({ query }) =>
          paginate((l, o) => loadPending(memory, query.layer, l, o), query),
        { query: PENDING_QUERY },
      )
      .patch(
        "/:layer/:id/status",
        ({ params, body }) =>
          patchStatus(memory, params.layer, params.id, body.status),
        { params: STATUS_PARAMS, body: STATUS_BODY },
      )

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
