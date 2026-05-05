/**
 * Freelance scout admin routes.
 * Mounted after authMiddleware. See docs/tasks/03-freelance-search-mode.md.
 */

import type { FreelanceScout } from "@subbrain/agent/scheduler/freelance";
import type { FreelanceStatus, MemoryDB } from "@subbrain/core/db";
import { paginate } from "@subbrain/core/lib/api-envelope";
import { NotFoundError } from "@subbrain/core/lib/errors";
import { Elysia, t } from "elysia";

const STATUS_VALUES = t.Union([t.Literal("new"), t.Literal("taken"), t.Literal("rejected")]);

export function freelanceRoute(memory: MemoryDB, scout: FreelanceScout | null) {
  return new Elysia({ prefix: "/v1/search/freelance" })
    .post("/start", () => {
      if (!scout) return { ok: false, error: "scout not configured" };
      scout.start();
      return { ok: true };
    })
    .post("/stop", async () => {
      if (!scout) return { ok: false, error: "scout not configured" };
      await scout.stop();
      return { ok: true };
    })
    .get("/status", () => {
      if (!scout) {
        return {
          running: false,
          pausedUntil: [],
          lastRunAt: null,
          lastLeadAt: null,
          leadsToday: 0,
        };
      }
      return scout.status();
    })
    .get("/leads", ({ query }) => {
      const status =
        typeof query.status === "string" && ["new", "taken", "rejected"].includes(query.status)
          ? (query.status as FreelanceStatus)
          : undefined;
      return paginate((limit, offset) => {
        return memory.listFreelanceLeads({ status, limit, offset });
      }, query);
    })
    .patch(
      "/leads/:id",
      ({ params, body }) => {
        const row = memory.getFreelanceLead(params.id);
        if (!row) throw new NotFoundError(`lead ${params.id} not found`);
        memory.updateFreelanceStatus(params.id, body.status);
        return memory.getFreelanceLead(params.id);
      },
      { body: t.Object({ status: STATUS_VALUES }) },
    ) as unknown as Elysia;
}
