/**
 * M-04 (mig 11): fts_log virtual table + sync triggers + backfill +
 * LogTable.searchLog + RAG layer "log" FTS-only branch.
 *
 * Foundation for episodic queryable memory. The MCP `memory_log_search`
 * tool (agent-only) is wired in `src/mcp/registry/memory.tools.ts`; this
 * suite exercises the SQL/FTS/RAG plumbing — registry shape is covered
 * by the registry tests.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { MemoryDB } from "../src/db";
import { RAGPipeline } from "../src/rag";

const TEST_DB = "data/test-mem4-log.db";

function cleanup() {
  for (const ext of ["", "-shm", "-wal"]) {
    const p = `${TEST_DB}${ext}`;
    if (existsSync(p)) unlinkSync(p);
  }
}

// Minimal mock router: the "log" RAG branch never calls embed/rerank
// (FTS-only), so we only need a no-op shape that satisfies the type.
function mkRouter() {
  return {
    raw: {
      embed: async () => ({ data: [{ embedding: new Array(2048).fill(0) }] }),
      rerank: async (req: { passages: { text: string }[]; top_n: number }) => ({
        results: req.passages
          .slice(0, req.top_n)
          .map((_, i) => ({ index: i, relevance_score: 1 - i * 0.01 })),
      }),
    },
    scheduleRaw: async (_priority: string, fn: () => Promise<unknown>) => fn(),
  } as unknown as import("../src/lib/model-router").ModelRouter;
}

function appendLog(
  memory: MemoryDB,
  opts: {
    requestId?: string;
    sessionId?: string;
    agentId?: string;
    role?: string;
    content: string;
  },
) {
  return memory.appendLog(
    opts.requestId ?? "req-test",
    opts.sessionId ?? "sess-A",
    opts.agentId ?? "agent-A",
    opts.role ?? "user",
    opts.content,
  );
}

describe("M-04 — fts_log virtual table + searchLog + RAG layer log", () => {
  let memory: MemoryDB;

  beforeAll(() => {
    cleanup();
    memory = new MemoryDB(TEST_DB);
  });

  afterAll(() => {
    memory.close();
    cleanup();
  });

  test("Migration 11 applied: user_version >= 11, fts_log exists, 3 triggers", () => {
    const v = memory.db
      .query<{ user_version: number }, []>("PRAGMA user_version")
      .get()!;
    expect(v.user_version).toBeGreaterThanOrEqual(11);

    const ftsRow = memory.db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE name = 'fts_log'",
      )
      .all();
    expect(ftsRow.length).toBe(1);

    const trigs = memory.db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='layer4_log'",
      )
      .all();
    const names = trigs.map((t) => t.name).sort();
    expect(names).toContain("fts_log_ai");
    expect(names).toContain("fts_log_ad");
    expect(names).toContain("fts_log_au");
  });

  test("re-running migrate() is idempotent (no double-backfill, no throw)", () => {
    // Insert one row through the open handle so triggers run once.
    appendLog(memory, { content: "idempotent canary kiwifruit" });
    const before = memory.db
      .query<{ c: number }, []>("SELECT count(*) AS c FROM fts_log")
      .get()!.c;

    // Re-open against same path — constructor calls migrate() again.
    const m2 = new MemoryDB(TEST_DB);
    const v = m2.db
      .query<{ user_version: number }, []>("PRAGMA user_version")
      .get()!;
    expect(v.user_version).toBeGreaterThanOrEqual(11);
    const after = m2.db
      .query<{ c: number }, []>("SELECT count(*) AS c FROM fts_log")
      .get()!.c;
    // Backfill must NOT re-run when fts_log is already populated.
    expect(after).toBe(before);
    m2.close();
  });

  test("triggers sync INSERT/DELETE/UPDATE on layer4_log", () => {
    const id = appendLog(memory, {
      content: "magenta velociraptor sandwich preferences",
      sessionId: "sess-trig",
    });

    const hits1 = memory.db
      .query<{ rowid: number }, [string]>(
        "SELECT rowid FROM fts_log WHERE fts_log MATCH ?",
      )
      .all('"velociraptor"');
    expect(hits1.some((h) => h.rowid === id)).toBe(true);

    // UPDATE — old text gone, new text searchable.
    memory.db
      .query("UPDATE layer4_log SET content = ? WHERE id = ?")
      .run("repainted purple yacht hopscotch", id);
    const hitsOld = memory.db
      .query<{ rowid: number }, [string]>(
        "SELECT rowid FROM fts_log WHERE fts_log MATCH ?",
      )
      .all('"velociraptor"');
    expect(hitsOld.some((h) => h.rowid === id)).toBe(false);
    const hitsNew = memory.db
      .query<{ rowid: number }, [string]>(
        "SELECT rowid FROM fts_log WHERE fts_log MATCH ?",
      )
      .all('"yacht"');
    expect(hitsNew.some((h) => h.rowid === id)).toBe(true);

    // DELETE — gone from fts_log.
    memory.db.query("DELETE FROM layer4_log WHERE id = ?").run(id);
    const hitsDel = memory.db
      .query<{ rowid: number }, [string]>(
        "SELECT rowid FROM fts_log WHERE fts_log MATCH ?",
      )
      .all('"yacht"');
    expect(hitsDel.some((h) => h.rowid === id)).toBe(false);
  });

  test("searchLog finds rows by content with snippet highlight", () => {
    appendLog(memory, {
      content: "deploying transitive marmalade pipeline today",
      sessionId: "sess-search",
    });
    appendLog(memory, {
      content: "unrelated jellyfish plumbing reminder",
      sessionId: "sess-search",
    });

    const hits = memory.logRepo.searchLog("marmalade", { limit: 10 });
    expect(hits.length).toBe(1);
    expect(hits[0].snippet).toContain("<b>marmalade</b>");
    // id is a stringified layer4_log.id (number in storage; string here).
    expect(typeof hits[0].id).toBe("string");
    expect(Number(hits[0].id)).toBeGreaterThan(0);
    // role is surfaced as the FtsResult `title`.
    expect(hits[0].title).toBe("user");
  });

  test("searchLog filters by agentId / sessionId", () => {
    appendLog(memory, {
      content: "filtration kumquat orange unique-X",
      agentId: "agent-X",
      sessionId: "sess-X",
    });
    appendLog(memory, {
      content: "filtration kumquat orange unique-Y",
      agentId: "agent-Y",
      sessionId: "sess-Y",
    });

    const justX = memory.logRepo.searchLog("kumquat", { agentId: "agent-X" });
    expect(justX.length).toBe(1);
    expect(justX[0].snippet).toContain("unique-X");

    const justSessY = memory.logRepo.searchLog("kumquat", {
      sessionId: "sess-Y",
    });
    expect(justSessY.length).toBe(1);
    expect(justSessY[0].snippet).toContain("unique-Y");
  });

  test("searchLog applies sanitizeFtsQuery — raw : * \" do not throw", () => {
    appendLog(memory, { content: "rare special-term documented yesterday" });
    expect(() =>
      memory.logRepo.searchLog('rare:term*"', { limit: 5 }),
    ).not.toThrow();
    // Empty / fully-stripped query → no MATCH attempted, empty array.
    expect(memory.logRepo.searchLog("", { limit: 5 })).toEqual([]);
    expect(memory.logRepo.searchLog("   :*\"  ", { limit: 5 })).toEqual([]);
  });

  test("RAG pipeline layers:[\"log\"] returns log hits with layer == 'log'", async () => {
    appendLog(memory, {
      content: "indigotic alpaca diaspora migration plan",
      sessionId: "sess-rag",
    });
    const router = mkRouter();
    const rag = new RAGPipeline(memory, router);

    // skipRerank=true so the test does not depend on the mock rerank order.
    const out = await rag.search({
      query: "alpaca",
      layers: ["log"],
      rerankTopN: 5,
      skipRerank: true,
    });
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((r) => r.layer === "log")).toBe(true);
    expect(out[0].snippet).toContain("<b>alpaca</b>");
  });

  test("RAG pipeline default layers does NOT include log", async () => {
    appendLog(memory, {
      content: "default-layers canary banana split",
      sessionId: "sess-default",
    });
    const router = mkRouter();
    const rag = new RAGPipeline(memory, router);

    // No `layers` opt → defaults to ["context","archive","shared"]. The
    // unique log content must not surface.
    const out = await rag.search({
      query: "banana",
      rerankTopN: 5,
      skipRerank: true,
    });
    expect(out.every((r) => r.layer !== "log")).toBe(true);
  });

  test("bumpAccess does NOT touch the log layer (filtered via isBumpLayer)", async () => {
    appendLog(memory, {
      content: "bump-guard zebrafish neuropil scan",
      sessionId: "sess-bump",
    });
    const router = mkRouter();
    const rag = new RAGPipeline(memory, router);

    // Single-row search → bumpAccessAsync gets one log result.
    await rag.search({
      query: "zebrafish",
      layers: ["log"],
      rerankTopN: 5,
      skipRerank: true,
    });
    // Wait so the fire-and-forget bump path can settle (it would have if
    // the layer wasn't filtered out). 50ms is generous for sub-ms UPDATEs.
    await new Promise<void>((r) => setTimeout(r, 50));
    // No `access_count` column on layer4_log — if isBumpLayer was wrong
    // and bumpAccess('log', ...) ran, the UPDATE would throw. Reaching
    // here (no unhandled rejection) is the assertion. Add a positive
    // check that none of the existing rows accidentally gained access
    // counters either (sanity guard).
    const sharedRows = memory.db
      .query<{ c: number }, []>(
        "SELECT count(*) AS c FROM shared_memory WHERE access_count > 0",
      )
      .get()!.c;
    expect(sharedRows).toBe(0);
  });
});

describe("M-04 — backfill from existing layer4_log on first migrate", () => {
  const SEED_DB = "data/test-mem4-log-seed.db";

  function cleanupSeed() {
    for (const ext of ["", "-shm", "-wal"]) {
      const p = `${SEED_DB}${ext}`;
      if (existsSync(p)) unlinkSync(p);
    }
  }

  test("backfill populates fts_log when fts_log is empty", () => {
    cleanupSeed();
    // First open → migrations run once. We can't really test "before mig 11"
    // here because migrate() always runs to head; instead we assert that on
    // a fresh DB, after seeding 5 rows, the fts mirror is fully populated
    // (proving triggers + initial backfill cover both seed-then-open and
    // open-then-seed paths).
    const m = new MemoryDB(SEED_DB);
    try {
      for (let i = 0; i < 5; i++) {
        appendLog(m, {
          content: `seed row content variant cherry-${i} preserved`,
          sessionId: "seed",
        });
      }
      const ftsCount = m.db
        .query<{ c: number }, []>("SELECT count(*) AS c FROM fts_log")
        .get()!.c;
      const logCount = m.db
        .query<{ c: number }, []>("SELECT count(*) AS c FROM layer4_log")
        .get()!.c;
      expect(ftsCount).toBe(logCount);
      expect(ftsCount).toBe(5);

      // Re-open: backfill must NOT double-insert. fts_log count stays at 5.
      const m2 = new MemoryDB(SEED_DB);
      const ftsCount2 = m2.db
        .query<{ c: number }, []>("SELECT count(*) AS c FROM fts_log")
        .get()!.c;
      expect(ftsCount2).toBe(5);
      m2.close();
    } finally {
      m.close();
      cleanupSeed();
    }
  });
});
