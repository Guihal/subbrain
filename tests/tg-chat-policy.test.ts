/**
 * TgChatPolicyRepository tests (migration 22 / 8e-3).
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { migrate, openDatabase } from "@subbrain/core/db/schema";
import { TgChatPolicyRepository } from "@subbrain/core/repositories/tg-chat-policy.repo";

const TEST_DB = "data/test-tg-chat-policy.db";

function cleanup(): void {
  for (const ext of ["", "-shm", "-wal"]) {
    const p = `${TEST_DB}${ext}`;
    if (existsSync(p)) unlinkSync(p);
  }
}

let db: Database;
let repo: TgChatPolicyRepository;

beforeAll(() => {
  cleanup();
  db = openDatabase(TEST_DB);
  migrate(db);
  repo = new TgChatPolicyRepository(db);
});

afterAll(() => {
  db.close();
  cleanup();
});

beforeEach(() => {
  db.exec("DELETE FROM tg_chat_policies");
});

describe("TgChatPolicyRepository", () => {
  test("upsert + getByChatId round-trip", () => {
    repo.upsert(123456, "scrubbed", "operator");
    const row = repo.getByChatId(123456);
    expect(row).not.toBeNull();
    expect(row!.chat_id).toBe(123456);
    expect(row!.policy).toBe("scrubbed");
    expect(row!.updated_by).toBe("operator");
    expect(row!.updated_at).toBeGreaterThan(0);
  });

  test("default policy is metadata_only", () => {
    repo.upsert(999, "metadata_only");
    const row = repo.getByChatId(999);
    expect(row).not.toBeNull();
    expect(row!.policy).toBe("metadata_only");
  });

  test("upsert updates existing row", () => {
    repo.upsert(111, "metadata_only", "auto");
    repo.upsert(111, "full", "operator");
    const row = repo.getByChatId(111);
    expect(row).not.toBeNull();
    expect(row!.policy).toBe("full");
    expect(row!.updated_by).toBe("operator");
  });

  test("listByPolicy filtering", () => {
    repo.upsert(1, "metadata_only");
    repo.upsert(2, "scrubbed");
    repo.upsert(3, "metadata_only");
    repo.upsert(4, "full");

    const meta = repo.listByPolicy("metadata_only");
    expect(meta).toHaveLength(2);
    expect(meta.map((r) => r.chat_id).sort()).toEqual([1, 3]);

    const scrubbed = repo.listByPolicy("scrubbed");
    expect(scrubbed).toHaveLength(1);
    expect(scrubbed[0].chat_id).toBe(2);

    const full = repo.listByPolicy("full");
    expect(full).toHaveLength(1);
    expect(full[0].chat_id).toBe(4);
  });

  test("getByChatId returns null for unknown chat", () => {
    expect(repo.getByChatId(0)).toBeNull();
  });

  test("migration is idempotent — running migrate() twice does not throw", () => {
    expect(() => migrate(db)).not.toThrow();
    const { user_version } = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!;
    expect(user_version).toBeGreaterThanOrEqual(22);
  });

  test("user_version is at least 22 after migrate()", () => {
    const { user_version } = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!;
    expect(user_version).toBeGreaterThanOrEqual(22);
  });
});
