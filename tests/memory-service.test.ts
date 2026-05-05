/**
 * MemoryService unit tests (PR 25b — LAYER-2 routes → services split).
 *
 * Asserts the service orchestrates `MemoryDB` and `RAGPipeline` correctly:
 *   - `insertShared` / `insertContext` embed-first then transactional
 *     insert+upsertEmbedding (no orphan row without vec).
 *   - `listShared({q})` routes through FTS (via `searchShared` → sanitize
 *     inside MemoryDB) and hydrates rows.
 *   - `listShared({status:"pending"})` returns only pending rows, and
 *     `setStatus("shared", id, "active")` flips the row — underlying path is
 *     the `updateRow(table, ALLOW, id, patch)` helper inside SharedTable.
 *   - Read-only methods (listAgent, listLog) proxy the right args.
 *
 * Uses a real sqlite DB at `data/test-memory-service.db` (bun:sqlite) and a
 * stub RAG that returns a deterministic embedding; no provider calls.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { MemoryDB } from "@subbrain/core/db";
import { RAGPipeline } from "../src/rag";
import { MemoryService } from "../src/services/memory";

const TEST_DB = "data/test-memory-service.db";

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

function cleanup(): void {
  for (const ext of ["", "-shm", "-wal"]) {
    const p = `${TEST_DB}${ext}`;
    if (existsSync(p)) unlinkSync(p);
  }
}

let memory: MemoryDB;
let rag: RAGPipeline;
let svc: MemoryService;

beforeAll(() => {
  cleanup();
  memory = new MemoryDB(TEST_DB);
  rag = new RAGPipeline(memory, mkRouter());
  svc = new MemoryService(memory.memoryRepo, rag, memory.logRepo);
});

afterAll(() => {
  memory.close();
  cleanup();
});

beforeEach(() => {
  // keep cross-test isolation on the shared DB
  memory.db.exec("DELETE FROM shared_memory");
  memory.db.exec("DELETE FROM layer2_context");
  memory.db.exec("DELETE FROM layer3_archive");
  memory.db.exec("DELETE FROM agent_memory");
  memory.db.exec("DELETE FROM vec_embeddings");
  memory.db.exec("DELETE FROM layer1_focus");
});

describe("MemoryService — focus KV", () => {
  test("upsertFocus / listFocus / deleteFocus round-trip", () => {
    svc.upsertFocus("current_task", "PR 25b");
    expect(svc.listFocus()).toEqual({ current_task: "PR 25b" });
    svc.deleteFocus("current_task");
    expect(svc.listFocus()).toEqual({});
  });
});

describe("MemoryService — insertShared (embed-first + transaction)", () => {
  test("returns new id, persists row + vec_embedding", async () => {
    const id = await svc.insertShared({
      category: "user",
      content: "Prefers dark mode",
      tags: "ui",
      confidence: 0.95,
      status: "active",
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    const row = memory.getShared(id)!;
    expect(row.category).toBe("user");
    expect(row.content).toBe("Prefers dark mode");
    expect(row.status).toBe("active");
    expect(row.confidence).toBeCloseTo(0.95, 5);

    const vec = memory.db
      .query("SELECT count(*) AS c FROM vec_embeddings WHERE id = ?")
      .get(id) as { c: number };
    expect(vec.c).toBe(1);
  });

  test("failed embed → no row written (transactional atomicity)", async () => {
    const badRag = {
      embedContent: async () => {
        throw new Error("upstream_down");
      },
    } as any;
    const badSvc = new MemoryService(memory.memoryRepo, badRag, memory.logRepo);
    await expect(
      badSvc.insertShared({ category: "c", content: "x", confidence: 0.9 }),
    ).rejects.toThrow();
    expect(memory.countShared()).toBe(0);
  });
});

describe("MemoryService — insertContext (embed-first + transaction)", () => {
  test("persists row + vec_embedding with derivedFrom", async () => {
    const id = await svc.insertContext({
      title: "finding",
      content: "redis TTL must be > 0",
      derivedFrom: ["req-1"],
      confidence: 0.85,
      status: "active",
    });
    const row = memory.getContext(id)!;
    expect(row.title).toBe("finding");
    expect(row.status).toBe("active");
    expect(JSON.parse(row.derived_from)).toEqual(["req-1"]);
  });
});

describe("MemoryService — listShared", () => {
  test("no q, no status → plain list + count", async () => {
    await svc.insertShared({ category: "a", content: "one", confidence: 0.9, status: "active" });
    await svc.insertShared({ category: "b", content: "two", confidence: 0.9, status: "active" });
    const r = svc.listShared({ limit: 10, offset: 0 });
    expect(r.total).toBe(2);
    expect(r.items).toHaveLength(2);
  });

  test("q filter → FTS hydrate", async () => {
    await svc.insertShared({
      category: "a",
      content: "dark chocolate",
      confidence: 0.9,
      status: "active",
    });
    await svc.insertShared({
      category: "b",
      content: "white coffee",
      confidence: 0.9,
      status: "active",
    });
    const r = svc.listShared({ limit: 10, offset: 0, q: "dark" });
    expect(r.items.length).toBeGreaterThanOrEqual(1);
    expect(r.items.every((x) => x.content.includes("dark"))).toBe(true);
  });

  test("status='pending' filter excludes active rows", async () => {
    await svc.insertShared({
      category: "a",
      content: "approved",
      confidence: 0.9,
      status: "active",
    });
    await svc.insertShared({
      category: "b",
      content: "waiting",
      confidence: 0.5,
      status: "pending",
    });
    const pending = svc.listShared({ limit: 10, offset: 0, status: "pending" });
    expect(pending.total).toBe(1);
    expect(pending.items[0].status).toBe("pending");
  });
});

describe("MemoryService — listPending / setStatus (22b compat)", () => {
  test("listPending('shared') returns only pending rows", async () => {
    const aId = await svc.insertShared({
      category: "a",
      content: "approved",
      confidence: 0.9,
      status: "active",
    });
    const bId = await svc.insertShared({
      category: "b",
      content: "waiting",
      confidence: 0.5,
      status: "pending",
    });
    const r = svc.listPending("shared", { limit: 10, offset: 0 });
    expect(r.total).toBe(1);
    expect(r.items.map((x) => x.id)).toEqual([bId]);
    // reference other id so tsc knows it's used:
    expect(aId).not.toBe(bId);
  });

  test("setStatus('shared', id, 'active') flips row status via updateRow", async () => {
    const id = await svc.insertShared({
      category: "a",
      content: "guess",
      confidence: 0.5,
      status: "pending",
    });
    svc.setStatus("shared", id, "active");
    expect(memory.getShared(id)?.status).toBe("active");
  });

  test("setStatus('context', id, 'rejected') flips row status", async () => {
    const id = await svc.insertContext({
      title: "t",
      content: "c",
      confidence: 0.5,
      status: "pending",
    });
    svc.setStatus("context", id, "rejected");
    expect(memory.getContext(id)?.status).toBe("rejected");
  });
});

describe("MemoryService — patch / delete", () => {
  test("patchShared applies allow-listed patch + returns row", async () => {
    const id = await svc.insertShared({
      category: "a",
      content: "initial",
      confidence: 0.9,
      status: "active",
    });
    const patched = svc.patchShared(id, { content: "updated", tags: "t1" });
    expect(patched?.content).toBe("updated");
    expect(patched?.tags).toBe("t1");
  });

  test("deleteShared removes row", async () => {
    const id = await svc.insertShared({
      category: "a",
      content: "x",
      confidence: 0.9,
      status: "active",
    });
    svc.deleteShared(id);
    expect(memory.getShared(id)).toBeNull();
  });
});

describe("MemoryService — agent / log read-only", () => {
  test("listAgent returns paginated result with items+total", () => {
    memory.insertAgentMemory("ag-1", "agent-A", "note one", "");
    memory.insertAgentMemory("ag-2", "agent-A", "note two", "");
    memory.insertAgentMemory("ag-3", "agent-B", "note three", "");
    const byAgent = svc.listAgent({ limit: 10, offset: 0, agentId: "agent-A" });
    expect(byAgent.total).toBe(2);
    expect(byAgent.items.every((r) => r.agent_id === "agent-A")).toBe(true);
    const all = svc.listAgent({ limit: 10, offset: 0 });
    expect(all.total).toBe(3);
  });

  test("listLog returns {items,total}", () => {
    memory.appendLog("req-1", "sess-1", "agent-A", "user", "hi");
    memory.appendLog("req-2", "sess-1", "agent-A", "assistant", "hello");
    const r = svc.listLog({ limit: 10, offset: 0, sessionId: "sess-1" });
    expect(r.total).toBe(2);
    expect(r.items.every((x) => x.session_id === "sess-1")).toBe(true);
  });
});
