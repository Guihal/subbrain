/**
 * MEM-6: admin /v1/memory/{shared,context}?active=true filters out
 * superseded + expired rows. Default (no ?active) shows full audit trail.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { MemoryDB } from "@subbrain/core/db";
import { Elysia } from "elysia";
import { RAGPipeline } from "../src/rag";
import { memoryRoute } from "../src/routes/memory";
import { MemoryService } from "../src/services/memory";

const TEST_DB = "data/test-mem-routes-active.db";

function fakeEmbed(text: string): Float32Array {
  const vec = new Float32Array(2048);
  for (let i = 0; i < text.length; i++) vec[text.charCodeAt(i) % 2048] += 1;
  vec[0] += 0.01;
  return vec;
}

function mkRouter() {
  return {
    raw: {
      embed: async (req: { input: string[] }) => ({
        data: req.input.map((t) => ({ embedding: Array.from(fakeEmbed(t)) })),
      }),
      rerank: async () => ({ results: [] }),
    },
    scheduleRaw: async (_p: string, fn: () => Promise<any>) => fn(),
  } as any;
}

function cleanup() {
  for (const ext of ["", "-shm", "-wal"]) {
    const p = `${TEST_DB}${ext}`;
    if (existsSync(p)) unlinkSync(p);
  }
}

describe("/v1/memory/* ?active=true (MEM-6)", () => {
  let memory: MemoryDB;
  let app: Elysia;
  let base: string;

  beforeAll(async () => {
    cleanup();
    memory = new MemoryDB(TEST_DB);
    const rag = new RAGPipeline(memory, mkRouter());
    const svc = new MemoryService(memory.memoryRepo, rag, memory.logRepo);
    app = new Elysia().use(memoryRoute(svc)).listen(0);
    base = `http://localhost:${app.server?.port}`;

    memory.insertShared("act-fresh", "preference", "fresh row", "");
    memory.insertShared("act-expired", "preference", "expired row", "");
    memory.updateShared("act-expired", { expires_at: Math.floor(Date.now() / 1000) - 60 });
    memory.insertShared("act-superseded", "preference", "superseded row", "");
    memory.updateShared("act-superseded", { superseded_by: "act-fresh" });
  });

  afterAll(() => {
    app.stop();
    memory.close();
    cleanup();
  });

  test("default (no ?active) returns ALL rows incl. superseded/expired", async () => {
    const r = await fetch(`${base}/v1/memory/shared?page_size=50`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { items: { id: string }[] };
    const ids = body.items.map((x) => x.id);
    expect(ids).toContain("act-fresh");
    expect(ids).toContain("act-expired");
    expect(ids).toContain("act-superseded");
  });

  test("?active=true hides superseded + expired", async () => {
    const r = await fetch(`${base}/v1/memory/shared?active=true&page_size=50`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { items: { id: string }[]; total: number };
    const ids = body.items.map((x) => x.id);
    expect(ids).toContain("act-fresh");
    expect(ids).not.toContain("act-expired");
    expect(ids).not.toContain("act-superseded");
  });

  test("?active=false (string) → default (full list)", async () => {
    const r = await fetch(`${base}/v1/memory/shared?active=false&page_size=50`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { items: { id: string }[] };
    const ids = body.items.map((x) => x.id);
    expect(ids).toContain("act-expired");
  });
});
