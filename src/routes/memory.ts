/** Memory admin routes — thin HTTP surface over `MemoryService`. No SQL here. */
import { Elysia, t } from "elysia";
import type { MemoryDB, MemoryKind, MemoryStatus } from "../db";
import type { EdgeKind } from "../db/types";
import { paginate } from "../lib/api-envelope";
import { NotFoundError } from "../lib/errors";
import type { EdgeLayer, MemoryService } from "../services/memory";
import { restoreFromArchive } from "../services/memory";

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;
const toStatus = (v: unknown): MemoryStatus | undefined =>
  v === "pending" || v === "active" || v === "rejected" ? v : undefined;
const toActive = (v: unknown): boolean =>
  typeof v === "string" && (v.toLowerCase() === "true" || v === "1");

const KIND_QUERY = t.Union([
  t.Literal("persona"),
  t.Literal("semantic"),
  t.Literal("episodic"),
  t.Literal("procedural"),
]);
const toKind = (v: unknown): MemoryKind | undefined =>
  v === "persona" || v === "semantic" || v === "episodic" || v === "procedural" ? v : undefined;

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
  // M-12 (mig 15): confidence unified to REAL [0..1] across all 3 layers.
  // Legacy 'HIGH'/'LOW' strings rejected by TypeBox here (returns 422);
  // see tests/memory-archive-confidence.test.ts.
  archive: t.Object({
    title: t.Optional(t.String()),
    content: t.Optional(t.String()),
    tags: t.Optional(t.String()),
    confidence: t.Optional(t.Number({ minimum: 0, maximum: 1 })),
  }),
  agent: t.Object({
    content: t.Optional(t.String()),
    tags: t.Optional(t.String()),
  }),
};

const PENDING_QUERY = t.Object({
  layer: t.Union([t.Literal("shared"), t.Literal("context")]),
  page: t.Optional(t.String()),
  page_size: t.Optional(t.String()),
  limit: t.Optional(t.String()),
  offset: t.Optional(t.String()),
});
const STATUS_PARAMS = t.Object({
  layer: t.Union([t.Literal("shared"), t.Literal("context")]),
  id: t.String(),
});
const STATUS_BODY = t.Object({
  status: t.Union([t.Literal("active"), t.Literal("rejected")]),
});

const EDGE_LAYER = t.Union([t.Literal("context"), t.Literal("shared"), t.Literal("archive")]);
const EDGE_KINDS_ALLOWED: ReadonlySet<EdgeKind> = new Set([
  "relates",
  "derives",
  "supersedes",
  "contradicts",
]);
function parseKindsCsv(raw: unknown): EdgeKind[] | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((k): k is EdgeKind => EDGE_KINDS_ALLOWED.has(k as EdgeKind));
}
const EDGE_PAGE = {
  kinds: t.Optional(t.String()),
  page: t.Optional(t.String()),
  page_size: t.Optional(t.String()),
  limit: t.Optional(t.String()),
  offset: t.Optional(t.String()),
};
const EDGES_QUERY = t.Object({
  from: t.String({ minLength: 1 }),
  fromLayer: EDGE_LAYER,
  ...EDGE_PAGE,
});
const RELATED_QUERY = t.Object({ id: t.String({ minLength: 1 }), layer: EDGE_LAYER, ...EDGE_PAGE });

export function memoryRoute(svc: MemoryService, memoryDb: MemoryDB) {
  return (
    new Elysia({ prefix: "/v1/memory" })
      .get("/focus", () => svc.listFocus())
      .put(
        "/focus/:key",
        ({ params, body }) => {
          svc.upsertFocus(params.key, body.value);
          return { key: params.key, value: body.value };
        },
        { body: t.Object({ value: t.String() }) },
      )
      .delete("/focus/:key", ({ params }) => (svc.deleteFocus(params.key), { ok: true }))
      .get(
        "/shared",
        ({ query }) =>
          paginate(
            (limit, offset, q) =>
              svc.listShared({
                limit,
                offset,
                q,
                category: str(query.category),
                status: toStatus(query.status),
                active: toActive(query.active),
                kind: toKind(query.kind),
              }),
            query,
          ),
        {
          query: t.Object({
            page: t.Optional(t.String()),
            page_size: t.Optional(t.String()),
            limit: t.Optional(t.String()),
            offset: t.Optional(t.String()),
            q: t.Optional(t.String()),
            category: t.Optional(t.String()),
            status: t.Optional(t.String()),
            active: t.Optional(t.String()),
            kind: t.Optional(KIND_QUERY),
          }),
        },
      )
      .patch(
        "/shared/:id",
        ({ params, body }) => {
          if (!svc.getShared(params.id)) throw new NotFoundError("Shared entry");
          return svc.patchShared(params.id, body);
        },
        { body: bodies.shared },
      )
      .delete("/shared/:id", ({ params }) => {
        if (!svc.getShared(params.id)) throw new NotFoundError("Shared entry");
        svc.deleteShared(params.id);
        return { ok: true };
      })
      .get("/context", ({ query }) =>
        paginate(
          (limit, offset, q) =>
            svc.listContext({
              limit,
              offset,
              q,
              status: toStatus(query.status),
              active: toActive(query.active),
            }),
          query,
        ),
      )
      .patch(
        "/context/:id",
        ({ params, body }) => {
          if (!svc.getContext(params.id)) throw new NotFoundError("Context entry");
          return svc.patchContext(params.id, body);
        },
        { body: bodies.context },
      )
      .delete("/context/:id", ({ params }) => {
        if (!svc.getContext(params.id)) throw new NotFoundError("Context entry");
        svc.deleteContext(params.id);
        return { ok: true };
      })
      .get("/archive", ({ query }) =>
        paginate((limit, offset, q) => svc.listArchive({ limit, offset, q }), query),
      )
      .patch(
        "/archive/:id",
        ({ params, body }) => {
          if (!svc.getArchive(params.id)) throw new NotFoundError("Archive entry");
          return svc.patchArchive(params.id, body);
        },
        { body: bodies.archive },
      )
      .delete("/archive/:id", ({ params }) => {
        if (!svc.getArchive(params.id)) throw new NotFoundError("Archive entry");
        svc.deleteArchive(params.id);
        return { ok: true };
      })
      .get("/agent/agents", () => svc.listAgentIds())
      .get("/agent", ({ query }) =>
        paginate(
          (limit, offset) => svc.listAgent({ limit, offset, agentId: str(query.agent_id) }),
          query,
        ),
      )
      .patch(
        "/agent/:id",
        ({ params, body }) => {
          if (!svc.getAgent(params.id)) throw new NotFoundError("Agent memory entry");
          return svc.patchAgent(params.id, body);
        },
        { body: bodies.agent },
      )
      .delete("/agent/:id", ({ params }) => {
        if (!svc.getAgent(params.id)) throw new NotFoundError("Agent memory entry");
        svc.deleteAgent(params.id);
        return { ok: true };
      })
      .get("/log/sessions", ({ query }) => svc.listLogSessions(Number(query.limit) || 50))
      .get("/log", ({ query }) =>
        paginate(
          (limit, offset) => svc.listLog({ limit, offset, sessionId: str(query.session_id) }),
          query,
        ),
      )
      // ─── PR 22b: pending approval ─────────────────────────────
      .get(
        "/pending",
        ({ query }) =>
          paginate((limit, offset) => svc.listPending(query.layer, { limit, offset }), query),
        { query: PENDING_QUERY },
      )
      .patch(
        "/:layer/:id/status",
        ({ params, body }) => {
          const row = svc.setStatus(params.layer, params.id, body.status);
          if (!row) {
            throw new NotFoundError(params.layer === "shared" ? "Shared entry" : "Context entry");
          }
          return row;
        },
        { params: STATUS_PARAMS, body: STATUS_BODY },
      )
      // M-14: read-only edges admin surface.
      .get(
        "/edges",
        ({ query }) =>
          paginate((limit, offset) => {
            const kinds = parseKindsCsv(query.kinds);
            // M-14 fixup: explicit empty allowlist (kinds CSV provided but ALL
            // values dropped by allowlist) → 0 results. Without this short-circuit
            // EdgesTable.getEdgesFromSrc treats `[]` same as undefined and falls
            // through to "all kinds" — silent semantic mismatch.
            if (Array.isArray(kinds) && kinds.length === 0) return { items: [], total: 0 };
            const all = svc.getEdgesFromSrc(query.from, query.fromLayer as EdgeLayer, kinds);
            return { items: all.slice(offset, offset + limit), total: all.length };
          }, query),
        { query: EDGES_QUERY },
      )
      .get(
        "/edges/related",
        ({ query }) =>
          paginate((limit, offset) => {
            const kinds = parseKindsCsv(query.kinds);
            if (Array.isArray(kinds) && kinds.length === 0) return { items: [], total: 0 };
            const all = svc.getRelatedDetailed(query.id, query.layer as EdgeLayer, kinds);
            return { items: all.slice(offset, offset + limit), total: all.length };
          }, query),
        { query: RELATED_QUERY },
      )
      // PR-B restore: move an archived janitor row back to its original layer.
      .post(
        "/restore",
        ({ body }) => {
          const row = svc.getArchive(body.id);
          if (!row) throw new NotFoundError("Archive entry");
          const restored = restoreFromArchive(memoryDb, body.id, row);
          return { ok: true as const, data: restored };
        },
        {
          body: t.Object({
            id: t.String({ minLength: 1 }),
          }),
        },
      )
  );
}
