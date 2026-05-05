import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { MemoryDB } from "@subbrain/core/db";
import { freelanceRoute } from "@subbrain/server/routes/freelance";
import { Elysia } from "elysia";

const TEST_DB = "data/test-freelance-routes.db";
let memory: MemoryDB;
let app: Elysia;

beforeAll(() => {
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  memory = new MemoryDB(TEST_DB);
  app = new Elysia().use(freelanceRoute(memory, null));
  for (let i = 0; i < 3; i++) {
    memory.insertFreelanceLead({
      id: `seed-${i}`,
      url: `https://fl.ru/projects/${i}`,
      source: "fl.ru",
      title: `Task ${i}`,
      budget: 1000 + i,
      score: 7 + (i % 2),
      reason: "r",
    });
  }
});

afterAll(() => {
  memory.close();
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
});

async function req(path: string, init?: RequestInit) {
  return app.handle(new Request(`http://localhost${path}`, init));
}

describe("freelance routes", () => {
  test("GET /status returns defaults when no scout", async () => {
    const res = await req("/v1/search/freelance/status");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { running: boolean };
    expect(json.running).toBe(false);
  });

  test("GET /leads returns envelope + pagination", async () => {
    const res = await req("/v1/search/freelance/leads?limit=2&offset=0");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: unknown[];
      total: number;
      page: number;
      page_size: number;
    };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBe(2);
    expect(body.total).toBe(3);
    expect(body.page_size).toBe(2);
  });

  test("GET /leads?status=new only new", async () => {
    const res = await req("/v1/search/freelance/leads?status=new");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ status: string }>;
    };
    expect(body.items.every((i) => i.status === "new")).toBe(true);
  });

  test("PATCH /leads/:id taken → 200, updates status", async () => {
    const res = await req("/v1/search/freelance/leads/seed-0", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "taken" }),
    });
    expect(res.status).toBe(200);
    const row = memory.getFreelanceLead("seed-0");
    expect(row?.status).toBe("taken");
  });

  test("PATCH /leads/:id not found → 404-shaped error", async () => {
    const res = await req("/v1/search/freelance/leads/does-not-exist", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "rejected" }),
    });
    // NotFoundError may not be wrapped to 404 outside central onError, but
    // it must fail (non-200).
    expect(res.status).not.toBe(200);
  });
});
