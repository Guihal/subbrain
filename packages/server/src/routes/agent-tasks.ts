/** Admin REST surface for agent_tasks. Thin HTTP wrapper over AgentTasksRepository. */

import { paginate } from "@subbrain/core/lib/api-envelope";
import { NotFoundError } from "@subbrain/core/lib/errors";
import type { AgentTasksRepository } from "@subbrain/core/repositories/agent-tasks.repo";
import { Elysia, t } from "elysia";

const TASK_TYPE = t.Union([
  t.Literal("free"),
  t.Literal("clear"),
  t.Literal("check-tg"),
  t.Literal("research"),
  t.Literal("find-new-task"),
]);

export function agentTasksRoute(repo: AgentTasksRepository) {
  return new Elysia({ prefix: "/v1/agent-tasks" })
    .get(
      "/",
      ({ query }) =>
        paginate((limit, offset) => {
          const status =
            typeof query.status === "string" && query.status.length > 0
              ? (query.status as import("@subbrain/core/db/tables/agent-tasks/types").AgentTaskStatus)
              : undefined;
          const type =
            typeof query.type === "string" && query.type.length > 0
              ? (query.type as import("@subbrain/core/db/tables/agent-tasks/types").AgentTaskType)
              : undefined;
          return repo.list({ status, type, limit, offset });
        }, query),
      {
        query: t.Object({
          status: t.Optional(t.String()),
          type: t.Optional(t.String()),
          page: t.Optional(t.String()),
          page_size: t.Optional(t.String()),
          limit: t.Optional(t.String()),
          offset: t.Optional(t.String()),
        }),
      },
    )
    .get("/:id", ({ params }) => {
      const row = repo.getById(Number(params.id));
      if (!row) throw new NotFoundError(`agent task ${params.id} not found`);
      return row;
    })
    .post(
      "/enqueue",
      ({ body }) => {
        const id = repo.enqueue({
          type: body.type,
          prompt: body.prompt,
          priority: body.priority,
          scheduledAt: body.scheduledAt,
          createdBy: body.createdBy,
        });
        return { id };
      },
      {
        body: t.Object({
          type: TASK_TYPE,
          prompt: t.String({ minLength: 1, maxLength: 8000 }),
          priority: t.Optional(t.Number()),
          scheduledAt: t.Optional(t.Number()),
          createdBy: t.String({ minLength: 1 }),
        }),
      },
    );
}
