/**
 * Memory admin routes — thin HTTP surface over `MemoryService` (PR 25b,
 * LAYER-2). No SQL here; enforced by grep gate on this file.
 */
import { Elysia, t } from "elysia";
import { paginate } from "../lib/api-envelope";
import { NotFoundError } from "../lib/errors";
import type { MemoryService } from "../services/memory.service";
import type { MemoryStatus } from "../db";

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;
const toStatus = (v: unknown): MemoryStatus | undefined =>
  v === "pending" || v === "active" || v === "rejected" ? v : undefined;

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

export function memoryRoute(svc: MemoryService) {
  return new Elysia({ prefix: "/v1/memory" })
    .get("/focus", () => svc.listFocus())
    .put("/focus/:key", ({ params, body }) => {
      svc.upsertFocus(params.key, body.value);
      return { key: params.key, value: body.value };
    }, { body: t.Object({ value: t.String() }) })
    .delete("/focus/:key", ({ params }) => (svc.deleteFocus(params.key), { ok: true }))
    .get("/shared", ({ query }) =>
      paginate((limit, offset, q) => svc.listShared({
        limit, offset, q,
        category: str(query.category), status: toStatus(query.status),
      }), query))
    .patch("/shared/:id", ({ params, body }) => {
      if (!svc.getShared(params.id)) throw new NotFoundError("Shared entry");
      return svc.patchShared(params.id, body);
    }, { body: bodies.shared })
    .delete("/shared/:id", ({ params }) => {
      if (!svc.getShared(params.id)) throw new NotFoundError("Shared entry");
      svc.deleteShared(params.id);
      return { ok: true };
    })
    .get("/context", ({ query }) =>
      paginate((limit, offset, q) =>
        svc.listContext({ limit, offset, q, status: toStatus(query.status) }), query))
    .patch("/context/:id", ({ params, body }) => {
      if (!svc.getContext(params.id)) throw new NotFoundError("Context entry");
      return svc.patchContext(params.id, body);
    }, { body: bodies.context })
    .delete("/context/:id", ({ params }) => {
      if (!svc.getContext(params.id)) throw new NotFoundError("Context entry");
      svc.deleteContext(params.id);
      return { ok: true };
    })
    .get("/archive", ({ query }) =>
      paginate((limit, offset, q) => svc.listArchive({ limit, offset, q }), query))
    .patch("/archive/:id", ({ params, body }) => {
      if (!svc.getArchive(params.id)) throw new NotFoundError("Archive entry");
      return svc.patchArchive(params.id, body);
    }, { body: bodies.archive })
    .delete("/archive/:id", ({ params }) => {
      if (!svc.getArchive(params.id)) throw new NotFoundError("Archive entry");
      svc.deleteArchive(params.id);
      return { ok: true };
    })
    .get("/agent/agents", () => svc.listAgentIds())
    .get("/agent", ({ query }) =>
      paginate((limit, offset) =>
        svc.listAgent({ limit, offset, agentId: str(query.agent_id) }), query))
    .patch("/agent/:id", ({ params, body }) => {
      if (!svc.getAgent(params.id)) throw new NotFoundError("Agent memory entry");
      return svc.patchAgent(params.id, body);
    }, { body: bodies.agent })
    .delete("/agent/:id", ({ params }) => {
      if (!svc.getAgent(params.id)) throw new NotFoundError("Agent memory entry");
      svc.deleteAgent(params.id);
      return { ok: true };
    })
    .get("/log/sessions", ({ query }) => svc.listLogSessions(Number(query.limit) || 50))
    .get("/log", ({ query }) =>
      paginate((limit, offset) =>
        svc.listLog({ limit, offset, sessionId: str(query.session_id) }), query));
}
