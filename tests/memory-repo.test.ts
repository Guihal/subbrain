/**
 * MemoryRepository unit tests (PR 27).
 *
 * Smoke-tests the wrapper over `db/tables/memory.ts` + `db/tables/shared.ts`:
 *   - shared CRUD + listByStatus (migrated out of MemoryService).
 *   - context insert + batch getMany.
 *   - `transaction()` rolls back on throw (atomicity guarantee services
 *     rely on for embed-first insert+upsertEmbedding).
 *
 * Uses a dedicated test DB so it stays isolated from memory-service.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { Database } from "bun:sqlite";
import { openDatabase, migrate } from "../src/db/schema";
import { MemoryRepository } from "../src/repositories/memory.repo";

const TEST_DB = "data/test-memory-repo.db";

function cleanup(): void {
  for (const ext of ["", "-shm", "-wal"]) {
    const p = `${TEST_DB}${ext}`;
    if (existsSync(p)) unlinkSync(p);
  }
}

let db: Database;
let repo: MemoryRepository;

beforeAll(() => {
  cleanup();
  db = openDatabase(TEST_DB);
  migrate(db);
  repo = new MemoryRepository(db);
});

afterAll(() => {
  db.close();
  cleanup();
});

beforeEach(() => {
  db.exec("DELETE FROM shared_memory");
  db.exec("DELETE FROM layer2_context");
  db.exec("DELETE FROM layer3_archive");
  db.exec("DELETE FROM agent_memory");
  db.exec("DELETE FROM vec_embeddings");
  db.exec("DELETE FROM layer1_focus");
});

describe("MemoryRepository — shared CRUD", () => {
  test("insert + get + count round-trip", () => {
    repo.insertShared("s1", "user", "prefers dark mode", "ui", "test", {
      confidence: 0.9,
      status: "active",
    });
    expect(repo.getShared("s1")!.content).toBe("prefers dark mode");
    expect(repo.countShared()).toBe(1);
  });

  test("getSharedMany returns requested ids in one pass", () => {
    repo.insertShared("s1", "a", "one", "", undefined, { confidence: 0.9 });
    repo.insertShared("s2", "b", "two", "", undefined, { confidence: 0.9 });
    repo.insertShared("s3", "c", "three", "", undefined, { confidence: 0.9 });
    const rows = repo.getSharedMany(["s1", "s3"]);
    expect(rows.map((r) => r.id).sort()).toEqual(["s1", "s3"]);
  });

  test("listShared pagination + countShared match", () => {
    for (let i = 0; i < 5; i++) {
      repo.insertShared(`s${i}`, "user", `n${i}`, "", undefined, { confidence: 0.9 });
    }
    const page1 = repo.listShared(3, 0);
    expect(page1).toHaveLength(3);
    expect(repo.countShared()).toBe(5);
  });

  test("updateShared flips status via updateRow (PR 22a allow-list)", () => {
    repo.insertShared("s1", "a", "x", "", undefined, { confidence: 0.5, status: "pending" });
    repo.updateShared("s1", { status: "active" });
    expect(repo.getShared("s1")!.status).toBe("active");
  });
});

describe("MemoryRepository — context batch + search", () => {
  test("insertContext + getContextMany", () => {
    repo.insertContext("c1", "t1", "cnt1");
    repo.insertContext("c2", "t2", "cnt2");
    const rows = repo.getContextMany(["c1", "c2"]);
    expect(rows).toHaveLength(2);
  });

  test("getContextMany activeOnly hides pending", () => {
    repo.insertContext("c1", "t1", "x", "", [], undefined, { status: "active" });
    repo.insertContext("c2", "t2", "y", "", [], undefined, { status: "pending" });
    const active = repo.getContextMany(["c1", "c2"], { activeOnly: true });
    expect(active.map((r) => r.id)).toEqual(["c1"]);
  });
});

describe("MemoryRepository — listByStatus (moved from MemoryService)", () => {
  test("shared pending filter", () => {
    repo.insertShared("s1", "a", "ok", "", undefined, { confidence: 0.9, status: "active" });
    repo.insertShared("s2", "b", "wait", "", undefined, { confidence: 0.5, status: "pending" });
    const r = repo.listByStatus("shared", "pending", 10, 0);
    expect(r.total).toBe(1);
    expect(r.items[0].id).toBe("s2");
  });

  test("context rejected filter", () => {
    repo.insertContext("c1", "t", "ok", "", [], undefined, { status: "active" });
    repo.insertContext("c2", "t", "no", "", [], undefined, { status: "rejected" });
    const r = repo.listByStatus("context", "rejected", 10, 0);
    expect(r.total).toBe(1);
    expect(r.items[0].id).toBe("c2");
  });
});

describe("MemoryRepository — transaction", () => {
  test("rolls back on throw (embed-first atomicity)", () => {
    expect(() => {
      repo.transaction(() => {
        repo.insertShared("s1", "a", "content", "", undefined, { confidence: 0.9 });
        throw new Error("simulated embed fail");
      });
    }).toThrow(/simulated embed fail/);
    expect(repo.getShared("s1")).toBeNull();
    expect(repo.countShared()).toBe(0);
  });

  test("commits on success", () => {
    repo.transaction(() => {
      repo.insertShared("s1", "a", "ok", "", undefined, { confidence: 0.9 });
      repo.upsertEmbedding("s1", "shared", new Float32Array(2048));
    });
    expect(repo.getShared("s1")!.id).toBe("s1");
    const vec = db
      .query("SELECT count(*) AS c FROM vec_embeddings WHERE id = ?")
      .get("s1") as { c: number };
    expect(vec.c).toBe(1);
  });
});

describe("MemoryRepository — focus KV (L1)", () => {
  test("set/get/delete round-trip", () => {
    repo.setFocus("current_task", "PR 27");
    expect(repo.getAllFocus()).toEqual({ current_task: "PR 27" });
    repo.deleteFocus("current_task");
    expect(repo.getAllFocus()).toEqual({});
  });
});
