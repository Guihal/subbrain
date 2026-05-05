/**
 * PR-B: Night-cycle memory janitor tests.
 * Each phase isolated + verifiable without network/embedding deps.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { runPhaseA } from "@subbrain/agent/pipeline/night-cycle/janitor/phase-a";
import { runPhaseB, runPhaseC } from "@subbrain/agent/pipeline/night-cycle/janitor/phase-bc";
import { runPhaseD } from "@subbrain/agent/pipeline/night-cycle/janitor/phase-d";
import type { RAGPipeline } from "@subbrain/agent/rag";
import { restoreFromArchive } from "@subbrain/agent/services/memory/archive-restore";
import { MemoryDB } from "@subbrain/core/db";

const DB_PATH = "data/test-janitor.db";

let memory: MemoryDB;

beforeEach(() => {
  // Clean up any stale WAL/SHM before opening.
  for (const ext of ["", "-shm", "-wal"]) {
    const p = DB_PATH + ext;
    if (existsSync(p)) unlinkSync(p);
  }
  memory = new MemoryDB(DB_PATH);
});

afterEach(() => {
  memory.close();
  for (const ext of ["", "-shm", "-wal"]) {
    const p = DB_PATH + ext;
    if (existsSync(p)) unlinkSync(p);
  }
});

// ─── Phase A: expired rows ────────────────────────────────

describe("Phase A — expired rows", () => {
  test("deletes shared_memory rows with expires_at < now()", () => {
    const past = Math.floor(Date.now() / 1000) - 100;
    memory.db
      .query(
        "INSERT INTO shared_memory (id, category, content, tags, expires_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("s1", "preference", "old pref", "", past);

    const result = runPhaseA(memory);
    expect(result.sharedDeleted).toBe(1);
    expect(memory.getShared("s1")).toBeNull();
  });

  test("keeps shared_memory rows with expires_at in future", () => {
    const future = Math.floor(Date.now() / 1000) + 86400;
    memory.db
      .query(
        "INSERT INTO shared_memory (id, category, content, tags, expires_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("s2", "preference", "fresh pref", "", future);

    const result = runPhaseA(memory);
    expect(result.sharedDeleted).toBe(0);
    expect(memory.getShared("s2")).not.toBeNull();
  });

  test("keeps shared_memory rows with expires_at NULL", () => {
    memory.insertShared("s3", "profile", "permanent", "", undefined);
    const result = runPhaseA(memory);
    expect(result.sharedDeleted).toBe(0);
    expect(memory.getShared("s3")).not.toBeNull();
  });

  test("deletes expired context rows", () => {
    const past = Math.floor(Date.now() / 1000) - 100;
    memory.db
      .query(
        "INSERT INTO layer2_context (id, title, content, tags, derived_from, expires_at) VALUES (?, ?, ?, ?, '[]', ?)",
      )
      .run("c1", "old ctx", "content", "", past);

    const result = runPhaseA(memory);
    expect(result.contextDeleted).toBe(1);
    expect(memory.getContext("c1")).toBeNull();
  });

  test("counts both layers", () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    memory.db
      .query(
        "INSERT INTO shared_memory (id, category, content, tags, expires_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("sa", "preference", "x", "", past);
    memory.db
      .query(
        "INSERT INTO layer2_context (id, title, content, tags, derived_from, expires_at) VALUES (?, ?, ?, ?, '[]', ?)",
      )
      .run("ca", "title", "x", "", past);

    const result = runPhaseA(memory);
    expect(result.sharedDeleted).toBe(1);
    expect(result.contextDeleted).toBe(1);
    expect(result.sharedDeleted + result.contextDeleted).toBe(2);
  });
});

// ─── Phase B: cosine dedup ────────────────────────────────

/** Minimal RAGPipeline-shape stub: only embedContent is consumed by phase-B. */
function mkRagStub(map: Record<string, Float32Array>): RAGPipeline {
  return {
    embedContent: async (content: string): Promise<Float32Array> => {
      const v = map[content];
      if (!v) throw new Error(`mkRagStub: no vector for content="${content}"`);
      return v;
    },
  } as unknown as RAGPipeline;
}

describe("Phase B — cosine dedup", () => {
  test("archives older row when cosine ≥ threshold", async () => {
    // Two near-duplicate context rows, fresh (within 7d window). Newer kept.
    memory.insertContext("ctx-new", "t-new", "alpha content", "");
    // Force older created_at on the second row so sort+keep-newest is deterministic.
    memory.db
      .query("UPDATE layer2_context SET created_at = ? WHERE id = ?")
      .run(Math.floor(Date.now() / 1000) - 3600, "ctx-old");
    memory.insertContext("ctx-old", "t-old", "alpha content variant", "");
    memory.db
      .query("UPDATE layer2_context SET created_at = ? WHERE id = ?")
      .run(Math.floor(Date.now() / 1000) - 7200, "ctx-old");

    const rag = mkRagStub({
      "alpha content": new Float32Array([1, 0, 0]),
      "alpha content variant": new Float32Array([1, 0, 0.001]),
    });

    const result = await runPhaseB(memory, rag);
    expect(result.dedupArchived).toBe(1);
    expect(memory.getContext("ctx-old")).toBeNull();
    expect(memory.getContext("ctx-new")).not.toBeNull();

    const archived = memory
      .listArchive()
      .find((a) => a.tags.includes("dedup-") && a.tags.includes("original_layer:context"));
    expect(archived).toBeDefined();
  });

  test("no archive when below threshold", async () => {
    memory.insertContext("ctx-a", "t-a", "topic alpha", "");
    memory.insertContext("ctx-b", "t-b", "topic beta", "");

    const rag = mkRagStub({
      "topic alpha": new Float32Array([1, 0, 0]),
      "topic beta": new Float32Array([0, 1, 0]),
    });

    const result = await runPhaseB(memory, rag);
    expect(result.dedupArchived).toBe(0);
    expect(memory.getContext("ctx-a")).not.toBeNull();
    expect(memory.getContext("ctx-b")).not.toBeNull();
  });
});

// ─── Phase C: legacy purge ────────────────────────────────

describe("Phase C — legacy purge (JANITOR_LEGACY_SWEEP=true)", () => {
  beforeEach(() => {
    process.env.JANITOR_LEGACY_SWEEP = "true";
  });

  afterEach(() => {
    delete process.env.JANITOR_LEGACY_SWEEP;
  });

  test("archives shared rows with unknown category", () => {
    memory.insertShared("leg1", "free-agent-digest", "old digest content", "");
    const result = runPhaseC(memory);
    expect(result.legacyArchived).toBeGreaterThanOrEqual(1);
    expect(memory.getShared("leg1")).toBeNull();
  });

  test("keeps whitelist-compliant shared rows", () => {
    memory.insertShared("wl1", "preference", "valid pref", "");
    const _result = runPhaseC(memory);
    expect(memory.getShared("wl1")).not.toBeNull();
  });

  test("archives context rows exceeding MAX_CONTEXT_CONTENT", () => {
    const bigContent = "x".repeat(2001);
    memory.insertContext("ctx-big", "big entry", bigContent, "");
    const result = runPhaseC(memory);
    expect(result.legacyArchived).toBeGreaterThanOrEqual(1);
    expect(memory.getContext("ctx-big")).toBeNull();
  });

  test("archive tag contains original_layer", () => {
    memory.insertShared("leg2", "free-agent-digest", "digest", "");
    runPhaseC(memory);
    const archives = memory.listArchive();
    const entry = archives.find((a) => a.tags.includes("original_layer:shared"));
    expect(entry).toBeDefined();
  });

  test("does nothing when JANITOR_LEGACY_SWEEP=false", () => {
    process.env.JANITOR_LEGACY_SWEEP = "false";
    memory.insertShared("noleg", "free-agent-digest", "digest", "");
    const result = runPhaseC(memory);
    expect(result.legacyArchived).toBe(0);
    expect(memory.getShared("noleg")).not.toBeNull();
  });
});

// ─── Phase D: done-task retention ─────────────────────────

describe("Phase D — done tasks (30d retention)", () => {
  test("deletes done tasks older than 30d", () => {
    const old = Math.floor(Date.now() / 1000) - 31 * 86400;
    memory.db
      .query(
        "INSERT INTO tasks (id, title, description, scope, status, completed_at) VALUES (?, ?, ?, ?, 'done', ?)",
      )
      .run("t1", "old done task", "", "autonomous", old);

    const result = runPhaseD(memory);
    expect(result.doneTasksDeleted).toBe(1);
  });

  test("keeps done tasks within 30d", () => {
    const recent = Math.floor(Date.now() / 1000) - 5 * 86400;
    memory.db
      .query(
        "INSERT INTO tasks (id, title, description, scope, status, completed_at) VALUES (?, ?, ?, ?, 'done', ?)",
      )
      .run("t2", "recent task", "", "autonomous", recent);

    const result = runPhaseD(memory);
    expect(result.doneTasksDeleted).toBe(0);
  });

  test("does not touch open or in_progress tasks", () => {
    const old = Math.floor(Date.now() / 1000) - 60 * 86400;
    memory.db
      .query(
        "INSERT INTO tasks (id, title, description, scope, status, updated_at) VALUES (?, ?, ?, ?, 'open', ?)",
      )
      .run("t3", "open task", "", "autonomous", old);

    const result = runPhaseD(memory);
    expect(result.doneTasksDeleted).toBe(0);
    expect(memory.db.query("SELECT id FROM tasks WHERE id='t3'").get()).not.toBeNull();
  });
});

// ─── Restore from archive ─────────────────────────────────

describe("restoreFromArchive", () => {
  test("restores shared row and removes archive entry", () => {
    process.env.JANITOR_LEGACY_SWEEP = "true";
    memory.insertShared("orig1", "free-agent-digest", "digest content", "");
    runPhaseC(memory);

    const archives = memory.listArchive();
    const arcEntry = archives.find((a) => a.tags.includes("original_layer:shared"));
    expect(arcEntry).toBeDefined();

    const result = restoreFromArchive(memory, arcEntry?.id, arcEntry!);
    expect(result.restoredLayer).toBe("shared");
    expect(memory.getArchive(arcEntry?.id)).toBeNull();

    delete process.env.JANITOR_LEGACY_SWEEP;
  });

  test("throws when archive entry has no original_layer tag", () => {
    memory.insertArchive("arc-no-tag", "title", "content", "no-layer-tag", [], 0.9, "test");
    const row = memory.getArchive("arc-no-tag")!;
    expect(() => restoreFromArchive(memory, "arc-no-tag", row)).toThrow("original_layer");
  });

  test("restores context row", () => {
    process.env.JANITOR_LEGACY_SWEEP = "true";
    const bigContent = "x".repeat(2001);
    memory.insertContext("ctx-restore", "ctx title", bigContent, "");
    runPhaseC(memory);

    const archives = memory.listArchive();
    const arcEntry = archives.find((a) => a.tags.includes("original_layer:context"));
    expect(arcEntry).toBeDefined();

    const result = restoreFromArchive(memory, arcEntry?.id, arcEntry!);
    expect(result.restoredLayer).toBe("context");
    expect(memory.getArchive(arcEntry?.id)).toBeNull();

    delete process.env.JANITOR_LEGACY_SWEEP;
  });
});
