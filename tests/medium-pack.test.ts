import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { MemoryDB } from "@subbrain/core/db";
import { Logger } from "@subbrain/core/lib/logger";
import { EMBED_MODEL, RERANK_MODEL } from "@subbrain/core/lib/model-map";
import { executeSandboxed } from "../src/pipeline/agent-loop/code-tools/sandbox";
import { logsRoute } from "../src/routes/logs";

const TEST_DB = "data/test-medium-pack.db";

function fresh(): MemoryDB {
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  return new MemoryDB(TEST_DB);
}

// ─── MED-1: generic updateRow ────────────────────────────

describe("MED-1: updateRow via allowlist", () => {
  let db: MemoryDB;
  beforeEach(() => {
    db = fresh();
  });
  afterEach(() => {
    db.close();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  });

  test("updateShared: only allowlisted columns write", () => {
    db.insertShared("s1", "cat", "orig content", "tag1");
    db.updateShared("s1", {
      content: "new",
      tags: "tag2",
      // @ts-expect-error — forbidden key must be ignored
      id: "bad",
    });
    const row = db.getShared("s1")!;
    expect(row.content).toBe("new");
    expect(row.tags).toBe("tag2");
    expect(row.id).toBe("s1");
  });

  test("updateShared: empty patch is a no-op (no UPDATE)", () => {
    db.insertShared("s2", "cat", "c", "t");
    const before = db.getShared("s2")?.updated_at;
    db.updateShared("s2", {});
    const after = db.getShared("s2")?.updated_at;
    expect(after).toBe(before);
  });

  test("updateArchive / updateContext accept confidence + tags", () => {
    db.insertContext("c1", "title", "content", "t");
    db.updateContext("c1", { title: "t2" });
    expect(db.getContext("c1")?.title).toBe("t2");

    // M-12 (mig 15): confidence unified to REAL [0..1] | null.
    db.insertArchive("a1", "T", "c", "t", [], 0.4);
    db.updateArchive("a1", { confidence: 0.9 });
    expect(db.getArchive("a1")?.confidence).toBe(0.9);
  });
});

// ─── MED-2: RERANK_MODEL / EMBED_MODEL constants ─────────

describe("MED-2: model constants exported", () => {
  test("constants are non-empty nvidia model ids", () => {
    expect(EMBED_MODEL.length).toBeGreaterThan(0);
    expect(RERANK_MODEL.length).toBeGreaterThan(0);
    expect(EMBED_MODEL.startsWith("nvidia/")).toBe(true);
    expect(RERANK_MODEL.startsWith("nvidia/")).toBe(true);
  });
});

// ─── MED-3: seed guard (exit 1 without --confirm) ────────

describe("MED-3: seed prod-path guard", () => {
  test("spawn scripts/seed.ts on prod path without --confirm → exit 1", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", "run", "scripts/seed.ts"],
      env: { ...process.env, DB_PATH: "data/subbrain.db" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    expect(exitCode).toBe(1);
  });
});

// ─── MED-4: logger meta serializes safely ────────────────

describe("MED-4: logger meta JSON-safe", () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  beforeEach(() => {
    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleSpy.mockRestore();
  });

  test("object meta value is stringified for DB write", () => {
    const log = new Logger("debug");
    const calls: unknown[][] = [];
    const fakeMemory = {
      appendLog: (...args: unknown[]) => {
        calls.push(args);
        return 0;
      },
    };
    log.setMemory(fakeMemory as unknown as MemoryDB);
    expect(() =>
      log.info("stage", "msg", { meta: { payload: { a: 1, b: [2, 3] } } }),
    ).not.toThrow();
    expect(calls.length).toBe(1);
    const content = calls[0][4] as string;
    expect(typeof content).toBe("string");
    expect(content).toContain("payload=");
    expect(content).toContain("{");
  });

  test("circular meta does not crash", () => {
    const log = new Logger("debug");
    const circ: Record<string, unknown> = { a: 1 };
    circ.self = circ;
    expect(() => log.info("stage", "m", { meta: { circ } })).not.toThrow();
  });
});

// ─── MED-5: sandbox without Worker throws ────────────────

describe("MED-5: sandbox Worker-availability guard", () => {
  test("Worker undefined → sandbox_unavailable", async () => {
    const orig = (globalThis as { Worker?: unknown }).Worker;
    (globalThis as { Worker?: unknown }).Worker = undefined;
    try {
      await expect(executeSandboxed("export default async () => 'x'", "")).rejects.toThrow(
        /sandbox_unavailable/,
      );
    } finally {
      (globalThis as { Worker?: unknown }).Worker = orig;
    }
  });
});

// ─── MED-10: migration v3 wrapped in transaction ─────────

describe("MED-10: migration v3 atomic", () => {
  const MIG_DB = "data/test-migration-v3.db";
  afterEach(() => {
    if (existsSync(MIG_DB)) unlinkSync(MIG_DB);
  });

  test("broken layer4_log at migration time → rollback keeps v2 schema", async () => {
    if (existsSync(MIG_DB)) unlinkSync(MIG_DB);
    // Build a DB at user_version=2 with an invalid row that will break
    // the `INSERT INTO layer4_log_new SELECT * FROM layer4_log` step:
    const raw = new Database(MIG_DB);
    raw.exec(`
      CREATE TABLE layer4_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id  TEXT NOT NULL,
        session_id  TEXT NOT NULL,
        agent_id    TEXT NOT NULL,
        role        TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool')),
        content     TEXT NOT NULL,
        token_count INTEGER,
        created_at  INTEGER NOT NULL DEFAULT (unixepoch())
      );
      INSERT INTO layer4_log (request_id, session_id, agent_id, role, content)
        VALUES ('r', 's', 'a', 'user', 'c');
      PRAGMA user_version = 2;
    `);
    // Sabotage: pre-create layer4_log_new with an impossible CHECK so that the
    // migration's "INSERT INTO layer4_log_new SELECT * FROM layer4_log" fails
    // mid-flight. Tx must roll back DROP/RENAME so v2 stays intact.
    raw.exec(`
      CREATE TABLE layer4_log_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id  TEXT NOT NULL,
        session_id  TEXT NOT NULL,
        agent_id    TEXT NOT NULL,
        role        TEXT NOT NULL CHECK(role = 'impossible_role'),
        content     TEXT NOT NULL,
        token_count INTEGER,
        created_at  INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);
    raw.close();

    // Open via MemoryDB — migrate() attempts v3, INSERT into tampered
    // layer4_log_new fails on CHECK, transaction must roll back so user_version
    // stays at 2 and layer4_log still holds its original row.
    try {
      const bad = new MemoryDB(MIG_DB);
      bad.close();
    } catch {
      // Either outcome is acceptable — the invariants below are what we care about.
    }

    const again = new Database(MIG_DB);
    const version = again
      .query<{ user_version: number }, []>("PRAGMA user_version")
      .get()?.user_version;
    expect(version).toBe(2);
    const row = again.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM layer4_log").get()!;
    expect(row.c).toBe(1);
    again.close();
  });
});

// ─── MED-11: routes/logs secret masking ──────────────────

describe("MED-11: /v1/logs masks secrets", () => {
  let db: MemoryDB;
  beforeEach(() => {
    db = fresh();
  });
  afterEach(() => {
    db.close();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  });

  test('default response masks "api_key":"secret" and raw=1 returns unmasked', async () => {
    db.appendLog(
      "req1",
      "sess1",
      "agentX",
      "system",
      'hello {"api_key":"super-secret","other":"ok"} world',
    );
    const app = logsRoute(db);
    const masked = await app.handle(new Request("http://localhost/v1/logs?limit=10"));
    const mBody = (await masked.json()) as {
      logs: { content: string }[];
    };
    expect(mBody.logs[0].content).toContain('"api_key":"***"');
    expect(mBody.logs[0].content).not.toContain("super-secret");

    const raw = await app.handle(new Request("http://localhost/v1/logs?limit=10&raw=1"));
    const rBody = (await raw.json()) as { logs: { content: string }[] };
    expect(rBody.logs[0].content).toContain("super-secret");
  });
});
