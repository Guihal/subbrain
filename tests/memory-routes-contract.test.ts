/**
 * Contract tests for `routes/memory.ts` after PR 25b (LAYER-2 services
 * split). Boots an Elysia app with `authMiddleware(AuthService)` +
 * `memoryRoute(MemoryService)` and asserts HTTP shape:
 *   - 401 without Bearer (middleware regression).
 *   - 200 + `{items,total,page,page_size}` envelope on list endpoints.
 *   - 404 `{error:{message}}` shape on PATCH of unknown id.
 *
 * No provider network calls — service is wired to a stub RAG returning a
 * deterministic embedding.
 */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { Elysia } from "elysia";
import { MemoryDB } from "../src/db";
import { RAGPipeline } from "../src/rag";
import { MemoryService } from "../src/services/memory";
import { AuthService } from "../src/services/auth.service";
import { authMiddleware } from "../src/lib/auth";
import { memoryRoute } from "../src/routes/memory";
import { AppError } from "../src/lib/errors";

const TEST_DB = "data/test-memory-routes.db";
const TOKEN = "test-memory-routes-token";

function fakeEmbed(text: string): Float32Array {
  const vec = new Float32Array(2048);
  for (let i = 0; i < text.length; i++) vec[text.charCodeAt(i) % 2048] += 1;
  vec[0] += 0.01;
  return vec;
}

function cleanup(): void {
  for (const ext of ["", "-shm", "-wal"]) {
    const p = `${TEST_DB}${ext}`;
    if (existsSync(p)) unlinkSync(p);
  }
}

let memory: MemoryDB;
let app: ReturnType<typeof buildApp>;
let base: string;

function buildApp() {
  memory = new MemoryDB(TEST_DB);
  const router = {
    raw: {
      embed: async (req: { input: string[] }) => ({
        data: req.input.map((t) => ({ embedding: Array.from(fakeEmbed(t)) })),
      }),
      rerank: async () => ({ results: [] }),
    },
    scheduleRaw: async (_p: string, fn: () => Promise<any>) => fn(),
  } as any;
  const rag = new RAGPipeline(memory, router);
  const svc = new MemoryService(memory.memoryRepo, rag, memory.logRepo);
  const auth = new AuthService(TOKEN);

  // Same 404 shape as the real onError: AppError → {error:{message,code}}.
  const a = new Elysia()
    .onError(({ error, set }) => {
      if (error instanceof AppError) {
        set.status = error.status;
        return { error: { message: error.message, code: error.code } };
      }
      set.status = 500;
      return { error: { message: "internal" } };
    })
    .use(authMiddleware(auth))
    .use(memoryRoute(svc, memory))
    .listen(0);
  return a;
}

beforeAll(async () => {
  cleanup();
  app = buildApp();
  base = `http://localhost:${app.server!.port}`;
  // seed a couple of rows
  await (app as any); // no-op, keep TS happy
});

afterAll(() => {
  app.stop();
  memory.close();
  cleanup();
});

const auth = { Authorization: `Bearer ${TOKEN}` };

describe("routes/memory — auth regression", () => {
  test("GET /v1/memory/shared without auth → 401", async () => {
    const r = await fetch(`${base}/v1/memory/shared`);
    expect(r.status).toBe(401);
    expect((await r.json()).error?.message).toBe("Unauthorized");
  });

  test("DELETE /v1/memory/shared/:id without auth → 401", async () => {
    const r = await fetch(`${base}/v1/memory/shared/any`, { method: "DELETE" });
    expect(r.status).toBe(401);
  });
});

describe("routes/memory — paginated envelope", () => {
  test("GET /v1/memory/shared → {items,total,page,page_size}", async () => {
    memory.insertShared("s1", "cat", "hello", "", undefined, { status: "active" });
    const r = await fetch(`${base}/v1/memory/shared`, { headers: auth });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toHaveProperty("items");
    expect(body).toHaveProperty("total");
    expect(body).toHaveProperty("page");
    expect(body).toHaveProperty("page_size");
    expect(Array.isArray(body.items)).toBe(true);
  });

  test("GET /v1/memory/context → envelope", async () => {
    const r = await fetch(`${base}/v1/memory/context`, { headers: auth });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.items).toBeDefined();
    expect(body.total).toBeDefined();
  });

  test("GET /v1/memory/archive → envelope", async () => {
    const r = await fetch(`${base}/v1/memory/archive`, { headers: auth });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.items).toBeDefined();
  });
});

describe("routes/memory — 404 shape", () => {
  test("PATCH /v1/memory/shared/unknown-id → 404 {error:{message}}", async () => {
    const r = await fetch(`${base}/v1/memory/shared/doesnotexist`, {
      method: "PATCH",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "x" }),
    });
    expect(r.status).toBe(404);
    const body = await r.json();
    expect(body.error?.message).toMatch(/not found/i);
  });

  test("DELETE /v1/memory/context/unknown-id → 404", async () => {
    const r = await fetch(`${base}/v1/memory/context/nope`, {
      method: "DELETE",
      headers: auth,
    });
    expect(r.status).toBe(404);
  });
});

describe("routes/memory — focus KV", () => {
  test("PUT /v1/memory/focus/:key → persists", async () => {
    const r = await fetch(`${base}/v1/memory/focus/mood`, {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ value: "focused" }),
    });
    expect(r.status).toBe(200);
    expect((await r.json()).value).toBe("focused");

    const g = await fetch(`${base}/v1/memory/focus`, { headers: auth });
    expect((await g.json()).mood).toBe("focused");
  });
});
