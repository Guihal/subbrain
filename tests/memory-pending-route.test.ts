/**
 * PR 22b: /v1/memory/pending route + PATCH /:layer/:id/status.
 *
 * Attaches the central onError shim locally (same contract as
 * `src/app/bootstrap.ts`) so NotFoundError serializes to 404 with the
 * `{ error: { message } }` envelope the UI expects.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { MemoryDB } from "@subbrain/core/db";
import { AppError } from "@subbrain/core/lib/errors";
import { memoryRoute } from "@subbrain/server/routes/memory";
import { Elysia } from "elysia";

const TEST_DB = "data/test-memory-pending-route.db";

function cleanup(): void {
  for (const ext of ["", "-shm", "-wal"]) {
    const p = `${TEST_DB}${ext}`;
    if (existsSync(p)) unlinkSync(p);
  }
}

function attachErrorHandler(app: Elysia): Elysia {
  return app.onError(({ code, error, set }) => {
    if (error instanceof AppError) {
      set.status = error.status;
      return {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ?? {}),
        },
      };
    }
    if (code === "VALIDATION") {
      set.status = 422;
      return {
        error: {
          code: "validation_error",
          message: (error as any)?.message ?? "invalid request",
        },
      };
    }
    set.status = 500;
    return { error: { code: "internal_error", message: "internal" } };
  });
}

let memory: MemoryDB;
let app: Elysia;

beforeAll(() => {
  cleanup();
  memory = new MemoryDB(TEST_DB);
  app = attachErrorHandler(new Elysia()).use(memoryRoute(memory, memory));

  // Seed: 2 shared pending, 1 shared active, 1 context pending, 1 context active.
  memory.insertShared("sp-1", "user", "pending shared 1", "", undefined, {
    confidence: 0.5,
    status: "pending",
  });
  memory.insertShared("sp-2", "user", "pending shared 2", "", undefined, {
    confidence: 0.6,
    status: "pending",
  });
  memory.insertShared("sa-1", "user", "active shared", "", undefined, {
    confidence: 0.95,
    status: "active",
  });
  memory.insertContext("cp-1", "ctx-title", "pending context 1", "", [], undefined, {
    confidence: 0.4,
    status: "pending",
  });
  memory.insertContext("ca-1", "ctx-title-2", "active context", "", [], undefined, {
    confidence: 0.9,
    status: "active",
  });
});

afterAll(() => {
  memory.close();
  cleanup();
});

async function req(path: string, init?: RequestInit) {
  return app.handle(new Request(`http://localhost${path}`, init));
}

describe("memory pending route (PR 22b)", () => {
  test("GET /v1/memory/pending?layer=shared returns only pending shared", async () => {
    const res = await req("/v1/memory/pending?layer=shared");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ id: string; status: string }>;
      total: number;
      page: number;
      page_size: number;
    };
    expect(body.total).toBe(2);
    expect(body.items).toHaveLength(2);
    for (const it of body.items) expect(it.status).toBe("pending");
    const ids = body.items.map((r) => r.id).sort();
    expect(ids).toEqual(["sp-1", "sp-2"]);
    expect(body.page).toBe(1);
    expect(body.page_size).toBeGreaterThan(0);
  });

  test("GET /v1/memory/pending?layer=context returns only pending context", async () => {
    const res = await req("/v1/memory/pending?layer=context");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ id: string; status: string }>;
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.items[0]?.id).toBe("cp-1");
    expect(body.items[0]?.status).toBe("pending");
  });

  test("GET /v1/memory/pending without layer → 422", async () => {
    const res = await req("/v1/memory/pending");
    expect(res.status).toBe(422);
  });

  test("GET /v1/memory/pending?layer=archive → 422 (invalid layer)", async () => {
    const res = await req("/v1/memory/pending?layer=archive");
    expect(res.status).toBe(422);
  });

  test("PATCH shared/:id/status {active} → 200 + row flipped", async () => {
    const res = await req("/v1/memory/shared/sp-1/status", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "active" }),
    });
    expect(res.status).toBe(200);
    const row = memory.getShared("sp-1");
    expect(row?.status).toBe("active");
  });

  test("PATCH context/:id/status {rejected} → 200 + row flipped", async () => {
    const res = await req("/v1/memory/context/cp-1/status", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "rejected" }),
    });
    expect(res.status).toBe(200);
    const row = memory.getContext("cp-1");
    expect(row?.status).toBe("rejected");
  });

  test("PATCH with invalid status → 422", async () => {
    const res = await req("/v1/memory/shared/sp-2/status", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "garbage" }),
    });
    expect(res.status).toBe(422);
  });

  test("PATCH missing id → 404 with {error:{message}}", async () => {
    const res = await req("/v1/memory/shared/does-not-exist/status", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "active" }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error).toBeDefined();
    expect(typeof body.error.message).toBe("string");
    expect(body.error.message).toMatch(/not found/i);
  });

  test("PATCH missing id (context) → 404", async () => {
    const res = await req("/v1/memory/context/does-not-exist/status", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "rejected" }),
    });
    expect(res.status).toBe(404);
  });

  test("PATCH with invalid layer → 422", async () => {
    const res = await req("/v1/memory/bogus/sp-2/status", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "active" }),
    });
    expect(res.status).toBe(422);
  });

  test("pending list excludes rows already flipped to active", async () => {
    // sp-1 was flipped → pending should now contain only sp-2.
    const res = await req("/v1/memory/pending?layer=shared");
    const body = (await res.json()) as {
      items: Array<{ id: string }>;
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.items[0]?.id).toBe("sp-2");
  });
});
