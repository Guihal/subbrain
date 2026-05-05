/**
 * HTTP surface for the tasks lifecycle store. SQL + history-loader logic
 * live in `TaskRepository`. 404 envelope: { error: { message } }.
 */

import { randomUUID } from "node:crypto";
import { Elysia, t } from "elysia";
import { InvalidTransitionError } from "../db";
import { paginate } from "../lib/api-envelope";
import { logger } from "../lib/logger";
import type { TaskRepository } from "../repositories/task.repo";

const log = logger.child("tasks.route");

const ScopeS = t.Union([
  t.Literal("global"),
  t.Literal("autonomous"),
  t.Literal("free-agent"),
  t.Literal("freelance"),
  t.Literal("tg"),
]);
const StatusFilterS = t.Union([
  t.Literal("active"),
  t.Literal("open"),
  t.Literal("in_progress"),
  t.Literal("done"),
  t.Literal("cancelled"),
]);
const TransitionS = t.Union([t.Literal("in_progress"), t.Literal("done"), t.Literal("cancelled")]);
const NumOrStr = t.Union([t.String(), t.Number()]);

const CreateBody = t.Object({
  title: t.String({ minLength: 1 }),
  description: t.Optional(t.String()),
  scope: t.Optional(ScopeS),
  priority: t.Optional(t.Integer({ minimum: 0, maximum: 10 })),
  due_at: t.Optional(t.Union([t.Number(), t.Null()])),
});
const PatchBody = t.Object({
  title: t.Optional(t.String({ minLength: 1 })),
  description: t.Optional(t.String()),
  priority: t.Optional(t.Integer({ minimum: 0, maximum: 10 })),
  due_at: t.Optional(t.Union([t.Number(), t.Null()])),
  status: t.Optional(TransitionS),
});
const ListQuery = t.Object({
  scope: t.Optional(ScopeS),
  status: t.Optional(StatusFilterS),
  limit: t.Optional(NumOrStr),
  offset: t.Optional(NumOrStr),
  page: t.Optional(NumOrStr),
  page_size: t.Optional(NumOrStr),
});
const HistoryQuery = t.Composite([ListQuery, t.Object({ since: t.Optional(NumOrStr) })]);

const JSON_HDR = { "Content-Type": "application/json" } as const;
const errResp = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: JSON_HDR });
const notFound = () => errResp(404, { error: { message: "Task not found" } });
const badTransition = (e: InvalidTransitionError) =>
  errResp(409, {
    error: { message: e.message, code: "invalid_transition", from: e.from, to: e.to },
  });

export function tasksRoute(repo: TaskRepository) {
  return new Elysia({ prefix: "/v1/tasks" })
    .get(
      "/",
      async ({ query }) =>
        paginate(
          (limit, offset) =>
            repo.listTasks({
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
      ({ body }) =>
        repo.insertTask({
          id: randomUUID(),
          title: body.title,
          description: body.description,
          scope: body.scope ?? "global",
          priority: body.priority ?? 0,
          due_at: body.due_at ?? null,
          source: "user",
        }),
      { body: CreateBody },
    )
    .get(
      "/history",
      async ({ query }) => {
        const since =
          query.since === undefined
            ? Math.floor(Date.now() / 1000) - 7 * 86400
            : Number(query.since);
        return paginate(repo.buildHistoryLoader(query.scope, since), query);
      },
      { query: HistoryQuery },
    )
    .get("/:id", ({ params }) => repo.getTask(params.id) ?? notFound())
    .patch(
      "/:id",
      ({ params, body }) => {
        if (!repo.getTask(params.id)) return notFound();
        const { status, ...patch } = body;
        try {
          repo.transaction(() => {
            if (Object.keys(patch).length > 0) repo.updateTask(params.id, patch);
            if (status) repo.transitionTask(params.id, status);
          });
        } catch (err) {
          if (err instanceof InvalidTransitionError) return badTransition(err);
          const msg = err instanceof Error ? err.message : String(err);
          log.error(`patch failed: ${msg}`);
          return errResp(500, { error: { message: msg } });
        }
        return repo.getTask(params.id);
      },
      { body: PatchBody },
    )
    .delete("/:id", ({ params }) => {
      if (!repo.getTask(params.id)) return notFound();
      repo.deleteTask(params.id);
      return { ok: true };
    });
}
