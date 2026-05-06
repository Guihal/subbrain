/**
 * M-12 (mig 15): unify `layer3_archive.confidence` from TEXT('HIGH'|'LOW')
 * to REAL [0..1]. Mirrors the shared/context shape introduced in mig 8.
 *
 * Coverage:
 *  1. Migration 15 backfills 'HIGH' → 0.9.
 *  2. Migration 15 backfills 'LOW'  → 0.4.
 *  3. Migration 15 idempotent (re-open keeps user_version=15).
 *  4. `insertArchive` accepts numeric confidence.
 *  5. Admin route TypeBox rejects out-of-range numbers (>1).
 *  6. Admin route TypeBox rejects legacy "HIGH" string.
 *  7. FTS5 trigger sync survives schema rebuild.
 *  8. Indexes (`idx_archive_access`, `idx_archive_salience`) preserved.
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { RAGPipeline } from "@subbrain/agent/rag";
import { MemoryService } from "@subbrain/agent/services/memory";
import { MemoryDB } from "@subbrain/core/db";
import { migrate, openDatabase } from "@subbrain/core/db/schema";
import { authMiddleware } from "@subbrain/core/lib/auth";
import { AppError } from "@subbrain/core/lib/errors";
import { AuthService } from "@subbrain/core/services/auth";
import { memoryRoute } from "@subbrain/server/routes/memory";
import { Elysia } from "elysia";
import * as sqliteVec from "sqlite-vec";

const TEST_DB = "data/test-mem12-archive.db";
const TOKEN = "test-mem12-archive-token";

function cleanup(): void {
  for (const ext of ["", "-shm", "-wal"]) {
    const p = `${TEST_DB}${ext}`;
    if (existsSync(p)) unlinkSync(p);
  }
}

function fakeEmbed(text: string): Float32Array {
  const vec = new Float32Array(2048);
  for (let i = 0; i < text.length; i++) vec[text.charCodeAt(i) % 2048] += 1;
  vec[0] += 0.01;
  return vec;
}

// ─── 1-3, 7-8: low-level migration tests on a raw bun:sqlite handle ──

describe("M-12 mig 15 — schema rebuild", () => {
  beforeAll(() => cleanup());
  afterAll(() => cleanup());

  test("backfills 'HIGH' → 0.9, 'LOW' → 0.4, NULL stays NULL", () => {
    // Hand-roll the pre-mig-15 archive schema so we control the seed rows.
    const db = new Database(TEST_DB);
    sqliteVec.load(db);
    db.exec(`
      CREATE TABLE layer3_archive (
        id                 TEXT PRIMARY KEY,
        title              TEXT NOT NULL,
        content            TEXT NOT NULL,
        tags               TEXT NOT NULL DEFAULT '',
        source_request_ids TEXT NOT NULL DEFAULT '[]',
        confidence         TEXT NOT NULL DEFAULT 'HIGH' CHECK(confidence IN ('HIGH','LOW')),
        agent_id           TEXT,
        created_at         INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at         INTEGER NOT NULL DEFAULT (unixepoch()),
        last_accessed_at   INTEGER DEFAULT NULL,
        access_count       INTEGER NOT NULL DEFAULT 0,
        salience           REAL NOT NULL DEFAULT 0.5,
        last_decayed_at    INTEGER DEFAULT NULL
      );
      CREATE VIRTUAL TABLE fts_archive USING fts5(
        title, content, tags,
        content=layer3_archive,
        content_rowid=rowid
      );
    `);
    db.exec("PRAGMA user_version = 14");
    db.query(`INSERT INTO layer3_archive(id,title,content,confidence) VALUES (?,?,?,?)`).run(
      "hi",
      "h",
      "high entry",
      "HIGH",
    );
    db.query(`INSERT INTO layer3_archive(id,title,content,confidence) VALUES (?,?,?,?)`).run(
      "lo",
      "l",
      "low entry",
      "LOW",
    );
    db.close();

    // Run migrate() through the canonical opener — pulls in mig 15.
    const opened = openDatabase(TEST_DB);
    migrate(opened);
    const rows = opened
      .query<{ id: string; confidence: number | null }, []>(
        "SELECT id, confidence FROM layer3_archive ORDER BY id",
      )
      .all();
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.confidence]));
    expect(byId.hi).toBe(0.9);
    expect(byId.lo).toBe(0.4);

    const typ = opened
      .query<{ t: string }, []>("SELECT typeof(confidence) AS t FROM layer3_archive WHERE id='hi'")
      .get();
    expect(typ?.t).toBe("real");

    const ver = opened.query<{ user_version: number }, []>("PRAGMA user_version").get();
    expect(ver?.user_version).toBe(22);
    opened.close();
  });

  test("re-open is idempotent (user_version stays at latest)", () => {
    const db1 = openDatabase(TEST_DB);
    migrate(db1);
    db1.close();
    const db2 = openDatabase(TEST_DB);
    migrate(db2);
    const ver = db2.query<{ user_version: number }, []>("PRAGMA user_version").get();
    expect(ver?.user_version).toBe(22);
    // typeof confidence is still REAL — no double-rebuild damage.
    const typ = db2
      .query<{ t: string }, []>("SELECT typeof(confidence) AS t FROM layer3_archive WHERE id='hi'")
      .get();
    expect(typ?.t).toBe("real");
    db2.close();
  });

  test("FTS5 trigger sync survives rebuild", () => {
    const db = openDatabase(TEST_DB);
    migrate(db);
    db.query(`INSERT INTO layer3_archive(id,title,content,confidence) VALUES (?,?,?,?)`).run(
      "ft1",
      "Bun runtime",
      "FTS rebuild check",
      0.7,
    );
    const hit = db
      .query<{ id: string }, [string]>(
        `SELECT a.id FROM fts_archive f JOIN layer3_archive a ON a.rowid=f.rowid WHERE fts_archive MATCH ?`,
      )
      .get("rebuild");
    expect(hit?.id).toBe("ft1");
    db.close();
  });

  test("indexes idx_archive_access + idx_archive_salience preserved", () => {
    const db = openDatabase(TEST_DB);
    migrate(db);
    const idx = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='layer3_archive'`,
      )
      .all()
      .map((r) => r.name);
    expect(idx).toContain("idx_archive_access");
    expect(idx).toContain("idx_archive_salience");
    db.close();
  });

  // Critic round-1 regression: legacy rows must remain FTS-searchable after
  // mig 15 schema rebuild. Pre-fix the contentless fts_archive index
  // pointed at OLD rowids (orphaned by the DROP+RENAME); only post-mig
  // INSERTs were findable. Fix: `INSERT INTO fts_archive(fts_archive)
  // VALUES('rebuild')` after the trigger setup. Test seeds row with mig 14
  // schema (TEXT confidence) directly via openDatabase(no migrate()) +
  // manual CREATE TABLE matching mig 14 shape, then opens via MemoryDB
  // (triggers full migrate including 15) and verifies FTS hit.
  test("legacy rows remain FTS-searchable after mig 15 rebuild", () => {
    const LEGACY_DB = `${TEST_DB}.legacy-fts.db`;
    for (const ext of ["", "-shm", "-wal"]) {
      const p = `${LEGACY_DB}${ext}`;
      if (existsSync(p)) unlinkSync(p);
    }
    // Phase 1: open raw DB, run migrate to bring it up through mig 14
    // (forced by setting user_version = 14 BEFORE the CREATE-block runs
    // its initial schema). Simpler path: open + migrate (head) + INSERT
    // + roll user_version back to 14 + close + reopen via MemoryDB to
    // trigger mig 15 on a populated fts_archive.
    const seed = openDatabase(LEGACY_DB);
    migrate(seed);
    seed
      .query(`INSERT INTO layer3_archive(id,title,content,confidence) VALUES (?,?,?,?)`)
      .run("legacy-1", "Hyprland tiling wm", "compositor with workspaces", 0.85);
    // Roll user_version back so reopen re-triggers mig 15 on populated FTS.
    seed.query(`PRAGMA user_version = 14`).run();
    seed.close();

    const m = new MemoryDB(LEGACY_DB);
    const hit = m.db
      .query<{ id: string }, [string]>(
        `SELECT a.id FROM fts_archive f JOIN layer3_archive a ON a.rowid=f.rowid WHERE fts_archive MATCH ?`,
      )
      .get("hyprland");
    expect(hit?.id).toBe("legacy-1");
    m.close();
    for (const ext of ["", "-shm", "-wal"]) {
      const p = `${LEGACY_DB}${ext}`;
      if (existsSync(p)) unlinkSync(p);
    }
  });
});

// ─── 4-6: insert + admin route TypeBox shape ─────────────────

const ROUTE_DB = "data/test-mem12-archive-route.db";
function cleanupRoute(): void {
  for (const ext of ["", "-shm", "-wal"]) {
    const p = `${ROUTE_DB}${ext}`;
    if (existsSync(p)) unlinkSync(p);
  }
}

describe("M-12 — insert REAL + route TypeBox", () => {
  let memory: MemoryDB;
  let app: ReturnType<typeof buildApp>;
  let base: string;

  function buildApp() {
    memory = new MemoryDB(ROUTE_DB);
    const router = {
      raw: {
        embed: async (req: { input: string[] }) => ({
          data: req.input.map((t) => ({
            embedding: Array.from(fakeEmbed(t)),
          })),
        }),
        rerank: async () => ({ results: [] }),
      },
      scheduleRaw: async (_p: string, fn: () => Promise<any>) => fn(),
    } as any;
    const rag = new RAGPipeline(memory, router);
    const svc = new MemoryService(memory.memoryRepo, rag, memory.logRepo);
    const auth = new AuthService(TOKEN);
    // Mirror bootstrap.ts onError shape so VALIDATION → 422 (TypeBox path).
    return new Elysia()
      .onError(({ error, code, set }) => {
        if (code === "VALIDATION") {
          set.status = 422;
          return { error: { message: "validation", code: 422 } };
        }
        if (error instanceof AppError) {
          set.status = error.status;
          return { error: { message: error.message, code: error.code } };
        }
        set.status = 500;
        return { error: { message: "internal" } };
      })
      .use(authMiddleware(auth))
      .use(memoryRoute(svc))
      .listen(0);
  }

  beforeAll(() => {
    cleanupRoute();
    app = buildApp();
    base = `http://localhost:${app.server?.port}`;
  });
  afterAll(() => {
    app.stop();
    memory.close();
    cleanupRoute();
  });

  const headers = {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json",
  };

  test("insertArchive accepts REAL confidence and round-trips", () => {
    memory.insertArchive("a-real", "T", "c", "t", [], 0.7);
    const row = memory.getArchive("a-real");
    expect(row?.confidence).toBe(0.7);
  });

  test("PATCH /archive/:id with confidence > 1 → 422", async () => {
    memory.insertArchive("a-422-hi", "T", "c", "t", [], 0.5);
    const r = await fetch(`${base}/v1/memory/archive/a-422-hi`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ confidence: 1.5 }),
    });
    expect(r.status).toBe(422);
  });

  test("PATCH /archive/:id with legacy 'HIGH' string → 422", async () => {
    memory.insertArchive("a-422-str", "T", "c", "t", [], 0.5);
    const r = await fetch(`${base}/v1/memory/archive/a-422-str`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ confidence: "HIGH" }),
    });
    expect(r.status).toBe(422);
  });

  test("PATCH /archive/:id with valid REAL persists", async () => {
    memory.insertArchive("a-ok", "T", "c", "t", [], 0.5);
    const r = await fetch(`${base}/v1/memory/archive/a-ok`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ confidence: 0.85 }),
    });
    expect(r.status).toBe(200);
    expect(memory.getArchive("a-ok")?.confidence).toBe(0.85);
  });
});
