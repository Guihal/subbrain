import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { MemoryDB } from "@subbrain/core/db";
import { agentTasksRoute } from "@subbrain/server/routes/agent-tasks";
import { Elysia } from "elysia";

const TEST_DB = "data/test-agent-tasks-routes.db";
let memory: MemoryDB;
let app: Elysia;

beforeAll(() => {
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  memory = new MemoryDB(TEST_DB);
  app = new Elysia().use(agentTasksRoute(memory.agentTasksRepo));
});

afterAll(() => {
  memory.close();
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
});

async function req(path: string, init?: RequestInit) {
  return app.handle(new Request(`http://localhost${path}`, init));
}

describe("agent-tasks routes", () => {
  test("POST /enqueue creates a task", async () => {
    const res = await req("/v1/agent-tasks/enqueue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "free",
        prompt: "test prompt",
        priority: 5,
        createdBy: "test",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: number };
    expect(typeof body.id).toBe("number");
  });

  test("POST /enqueue rejects invalid type", async () => {
    const res = await req("/v1/agent-tasks/enqueue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "invalid",
        prompt: "test",
        createdBy: "test",
      }),
    });
    expect(res.status).toBe(422);
  });

  test("GET / returns paginated list", async () => {
    const res = await req("/v1/agent-tasks?limit=10&offset=0");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: unknown[];
      total: number;
      page: number;
      page_size: number;
    };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.page_size).toBe(10);
  });

  test("GET /?status=pending filters", async () => {
    const res = await req("/v1/agent-tasks?status=pending");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ status: string }> };
    expect(body.items.every((i) => i.status === "pending")).toBe(true);
  });

  test("GET /:id returns row", async () => {
    const enqueueRes = await req("/v1/agent-tasks/enqueue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "clear",
        prompt: "get by id test",
        createdBy: "test",
      }),
    });
    const { id } = (await enqueueRes.json()) as { id: number };
    const res = await req(`/v1/agent-tasks/${id}`);
    expect(res.status).toBe(200);
    const row = (await res.json()) as { id: number; type: string };
    expect(row.id).toBe(id);
    expect(row.type).toBe("clear");
  });

  test("GET /:id not found → 404", async () => {
    const res = await req("/v1/agent-tasks/999999");
    expect(res.status).not.toBe(200);
  });
});
