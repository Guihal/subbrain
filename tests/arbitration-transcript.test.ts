/**
 * ArbitrationTranscriptRepository tests (P6-3).
 *
 * - Insert + retrieve round-trip
 * - List by room with ordering (turn_index ASC, created_at ASC)
 * - Migration idempotency (migrate() twice does not throw)
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { migrate, openDatabase } from "@subbrain/core/db/schema";
import { ArbitrationTranscriptRepository } from "@subbrain/core/repositories/arbitration-transcript.repo";

const TEST_DB = "data/test-arbitration-transcript.db";

function cleanup(): void {
  for (const ext of ["", "-shm", "-wal"]) {
    const p = `${TEST_DB}${ext}`;
    if (existsSync(p)) unlinkSync(p);
  }
}

let db: Database;
let repo: ArbitrationTranscriptRepository;

beforeAll(() => {
  cleanup();
  db = openDatabase(TEST_DB);
  migrate(db);
  repo = new ArbitrationTranscriptRepository(db);
});

afterAll(() => {
  db.close();
  cleanup();
});

beforeEach(() => {
  db.exec("DELETE FROM arbitration_transcripts");
});

describe("ArbitrationTranscriptRepository — CRUD", () => {
  test("insert + getById round-trip", () => {
    const id = repo.insert({
      room_id: "room-1",
      participant_id: "agent-a",
      role: "coder",
      turn_index: 0,
      content: "hello",
      tool_calls: null,
      created_at: Math.floor(Date.now() / 1000),
    });
    expect(id).toBeString();

    const row = repo.getById(id);
    expect(row).not.toBeNull();
    expect(row?.room_id).toBe("room-1");
    expect(row?.participant_id).toBe("agent-a");
    expect(row?.role).toBe("coder");
    expect(row?.turn_index).toBe(0);
    expect(row?.content).toBe("hello");
    expect(row?.tool_calls).toBeNull();
  });

  test("insert with tool_calls JSON", () => {
    const tc = JSON.stringify([{ name: "web_search", args: { q: "x" } }]);
    const id = repo.insert({
      room_id: "room-2",
      participant_id: "agent-b",
      role: "critic",
      turn_index: 1,
      content: "searching...",
      tool_calls: tc,
      created_at: 1234567890,
    });
    const row = repo.getById(id);
    expect(row?.tool_calls).toBe(tc);
  });
});

describe("ArbitrationTranscriptRepository — listByRoom", () => {
  test("orders by turn_index ASC, created_at ASC", () => {
    const base = 1000;
    repo.insert({
      room_id: "r1",
      participant_id: "p1",
      role: "coder",
      turn_index: 2,
      content: "second",
      tool_calls: null,
      created_at: base + 2,
    });
    repo.insert({
      room_id: "r1",
      participant_id: "p2",
      role: "critic",
      turn_index: 1,
      content: "first",
      tool_calls: null,
      created_at: base + 1,
    });
    repo.insert({
      room_id: "r1",
      participant_id: "p3",
      role: "teamlead",
      turn_index: 3,
      content: "third",
      tool_calls: null,
      created_at: base + 3,
    });

    const { items, total } = repo.listByRoom("r1");
    expect(total).toBe(3);
    expect(items.map((r) => r.turn_index)).toEqual([1, 2, 3]);
    expect(items.map((r) => r.content)).toEqual(["first", "second", "third"]);
  });

  test("pagination limit + offset", () => {
    for (let i = 0; i < 5; i++) {
      repo.insert({
        room_id: "r2",
        participant_id: `p${i}`,
        role: "coder",
        turn_index: i,
        content: `msg-${i}`,
        tool_calls: null,
        created_at: 1000 + i,
      });
    }
    const { items, total } = repo.listByRoom("r2", { limit: 2, offset: 1 });
    expect(total).toBe(5);
    expect(items).toHaveLength(2);
    expect(items[0].turn_index).toBe(1);
    expect(items[1].turn_index).toBe(2);
  });

  test("filters by room_id only", () => {
    repo.insert({
      room_id: "r-a",
      participant_id: "p1",
      role: "coder",
      turn_index: 0,
      content: "a",
      tool_calls: null,
      created_at: 1000,
    });
    repo.insert({
      room_id: "r-b",
      participant_id: "p2",
      role: "critic",
      turn_index: 0,
      content: "b",
      tool_calls: null,
      created_at: 1001,
    });

    const { items, total } = repo.listByRoom("r-a");
    expect(total).toBe(1);
    expect(items[0].content).toBe("a");
  });
});

describe("Migration 20 — idempotency", () => {
  test("running migrate() twice does not throw", () => {
    expect(() => migrate(db)).not.toThrow();
    const { user_version } = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!;
    expect(user_version).toBeGreaterThanOrEqual(20);
  });

  test("arbitration_transcripts table exists after migration", () => {
    const row = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='arbitration_transcripts'",
      )
      .get();
    expect(row).not.toBeNull();
    expect(row?.name).toBe("arbitration_transcripts");
  });

  test("indexes exist", () => {
    const indexes = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='arbitration_transcripts'",
      )
      .all()
      .map((r) => r.name)
      .filter((n) => !n.startsWith("sqlite_autoindex_"))
      .sort();
    expect(indexes).toEqual([
      "idx_arbtrans_created",
      "idx_arbtrans_part",
      "idx_arbtrans_room",
      "idx_arbtrans_turn",
    ]);
  });
});
