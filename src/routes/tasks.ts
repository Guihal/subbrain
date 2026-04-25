/**
 * HTTP surface for the tasks lifecycle store (Phase 1 + Phase 5).
 *
 * Registered after authMiddleware in src/app/bootstrap.ts. 404 envelope
 * shape matches chats.ts / memory.ts: { error: { message } }.
 *
 * /history is a strict-phase union: live completed tasks first (DESC
 * completed_at, honoring `scope` filter), then weekly digests (DESC
 * created_at, cross-scope — digests aggregate multiple scopes per week).
 * Pagination exhausts all live rows before any digest is returned; the
 * `total` field is `live.total + digestTotal`.
 */
import { Elysia, t } from "elysia";
import { randomUUID } from "node:crypto";
import type { MemoryDB, TaskScope, TaskStatus } from "../db";
import { InvalidTransitionError } from "../db";
import { paginate } from "../lib/api-envelope";
import { logger } from "../lib/logger";

const log = logger.child("tasks.route");

const TaskScopeSchema = t.Union([
  t.Literal("global"),
  t.Literal("autonomous"),
  t.Literal("free-agent"),
  t.Literal("freelance"),
  t.Literal("tg"),
]);

const TaskStatusFilterSchema = t.Union([
  t.Literal("active"),
  t.Literal("open"),
  t.Literal("in_progress"),
  t.Literal("done"),
  t.Literal("cancelled"),
]);

const CreateBody = t.Object({
  title: t.String({ minLength: 1 }),
  description: t.Optional(t.String()),
  scope: t.Optional(TaskScopeSchema),
  priority: t.Optional(t.Integer({ minimum: 0, maximum: 10 })),
  due_at: t.Optional(t.Union([t.Number(), t.Null()])),
});

const PatchBody = t.Object({
  title: t.Optional(t.String({ minLength: 1 })),
  description: t.Optional(t.String()),
  priority: t.Optional(t.Integer({ minimum: 0, maximum: 10 })),
  due_at: t.Optional(t.Union([t.Number(), t.Null()])),
  status: t.Optional(
    t.Union([
      t.Literal("in_progress"),
      t.Literal("done"),
      t.Literal("cancelled"),
    ]),
  ),
});

const ListQuery = t.Object({
  scope: t.Optional(TaskScopeSchema),
  status: t.Optional(TaskStatusFilterSchema),
  limit: t.Optional(t.Union([t.String(), t.Number()])),
  offset: t.Optional(t.Union([t.String(), t.Number()])),
  page: t.Optional(t.Union([t.String(), t.Number()])),
  page_size: t.Optional(t.Union([t.String(), t.Number()])),
});

const HistoryQuery = t.Composite([
  ListQuery,
  t.Object({ since: t.Optional(t.Union([t.String(), t.Number()])) }),
]);

interface DigestRow {
  id: string;
  title: string;
  content: string;
  tags: string;
  created_at: number;
}

export function buildHistoryLoader(
  memory: MemoryDB,
  scope: TaskScope | undefined,
  sinceUnix: number,
) {
  return (limit: number, offset: number) => {
    const live = memory.listCompletedTasksSince({
      scope,
      sinceUnix,
      limit,
      offset,
    });
    const remaining = limit - live.items.length;
    const digestOffset = Math.max(0, offset - live.total);
    const digests =
      remaining > 0
        ? (memory.db
            .query(
              `SELECT id, title, content, tags, created_at FROM layer3_archive
               WHERE tags LIKE 'tasks,digest,%' AND created_at >= ?
               ORDER BY created_at DESC LIMIT ? OFFSET ?`,
            )
            .all(sinceUnix, remaining, digestOffset) as DigestRow[])
        : [];
    const digestTotal = (
      memory.db
        .query(
          `SELECT COUNT(*) AS c FROM layer3_archive
           WHERE tags LIKE 'tasks,digest,%' AND created_at >= ?`,
        )
        .get(sinceUnix) as { c: number }
    ).c;
    return {
      items: [
        ...live.items.map((t) => ({ kind: "task" as const, ...t })),
        ...digests.map((d) => ({ kind: "digest" as const, ...d })),
      ],
      total: live.total + digestTotal,
    };
  };
}

function notFound(): Response {
  return new Response(
    JSON.stringify({ error: { message: "Task not found" } }),
    { status: 404, headers: { "Content-Type": "application/json" } },
  );
}

function badTransition(err: InvalidTransitionError): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: err.message,
        code: "invalid_transition",
        from: err.from,
        to: err.to,
      },
    }),
    { status: 409, headers: { "Content-Type": "application/json" } },
  );
}

export function tasksRoute(memory: MemoryDB) {
  return new Elysia({ prefix: "/v1/tasks" })
    .get(
      "/",
      async ({ query }) =>
        paginate(
          (limit, offset) =>
            memory.listTasks({
              scope: query.scope,
              status: query.status ?? "active",
              limit,
              offset,
            }),
          query,
        ),
      { query: ListQuery },
    )
    .post(
      "/",
      ({ body }) => {
        const id = randomUUID();
        return memory.insertTask({
          id,
          title: body.title,
          description: body.description,
          scope: body.scope ?? "global",
          priority: body.priority ?? 0,
          due_at: body.due_at ?? null,
          source: "user",
        });
      },
      { body: CreateBody },
    )
    .get(
      "/history",
      async ({ query }) => {
        const since =
          query.since === undefined
            ? Math.floor(Date.now() / 1000) - 7 * 86400
            : Number(query.since);
        return paginate(buildHistoryLoader(memory, query.scope, since), query);
      },
      { query: HistoryQuery },
    )
    .get("/:id", ({ params }) => {
      const row = memory.getTask(params.id);
      if (!row) return notFound();
      return row;
    })
    .patch(
      "/:id",
      ({ params, body }) => {
        const existing = memory.getTask(params.id);
        if (!existing) return notFound();
        const { status, ...patch } = body;
        try {
          memory.transaction(() => {
            if (Object.keys(patch).length > 0) {
              memory.updateTask(params.id, patch);
            }
            if (status) {
              memory.transitionTask(params.id, status);
            }
          });
        } catch (err) {
          if (err instanceof InvalidTransitionError) return badTransition(err);
          const msg = err instanceof Error ? err.message : String(err);
          log.error(`patch failed: ${msg}`);
          return new Response(JSON.stringify({ error: { message: msg } }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
        return memory.getTask(params.id);
      },
      { body: PatchBody },
    )
    .delete("/:id", ({ params }) => {
      const existing = memory.getTask(params.id);
      if (!existing) return notFound();
      memory.deleteTask(params.id);
      return { ok: true };
    });
}
