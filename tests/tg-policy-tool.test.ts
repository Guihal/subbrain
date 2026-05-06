/**
 * tg_set_chat_policy + tg_list_chats policy field tests (8e-5).
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { MemoryDB } from "@subbrain/core/db";

const TEST_DB = "data/test-tg-policy-tool.db";

function cleanup(): void {
  for (const ext of ["", "-shm", "-wal"]) {
    const p = `${TEST_DB}${ext}`;
    if (existsSync(p)) unlinkSync(p);
  }
}

let db: MemoryDB;

beforeAll(() => {
  cleanup();
  db = new MemoryDB(TEST_DB);
});

afterAll(() => {
  db.close();
  cleanup();
});

beforeEach(() => {
  db.db.exec("DELETE FROM tg_chat_policies");
  db.db.exec("DELETE FROM tg_excluded_chats");
});

describe("tg_set_chat_policy", () => {
  test("upserts policy into tg_chat_policies", () => {
    db.setChatPolicy("12345", "scrubbed", "operator");
    const rows = db.listKnownTgChats();
    expect(rows).toHaveLength(1);
    expect(rows[0].chat_id).toBe(12345);
    expect(rows[0].policy).toBe("scrubbed");
    expect(rows[0].updated_by).toBe("operator");
  });

  test("updates existing policy", () => {
    db.setChatPolicy("999", "metadata_only");
    db.setChatPolicy("999", "full", "auto");
    const row = db.listKnownTgChats()[0];
    expect(row.policy).toBe("full");
    expect(row.updated_by).toBe("auto");
  });

  test("listKnownTgChats returns empty when no policies", () => {
    expect(db.listKnownTgChats()).toHaveLength(0);
  });
});

describe("tg_list_chats policy field", () => {
  test("default policy is metadata_only when no row", () => {
    // Simulate what listChats read.ts does: lookup policy in map, default metadata_only
    const policies = new Map<string, string>();
    const policy = policies.get("123") ?? "metadata_only";
    expect(policy).toBe("metadata_only");
  });

  test("policy map reflects stored row", () => {
    db.setChatPolicy("777", "full");
    const policies = new Map(db.listKnownTgChats().map((r) => [String(r.chat_id), r.policy]));
    expect(policies.get("777")).toBe("full");
  });
});

describe("excludeTgChat back-compat", () => {
  test("exclude + include round-trip still works", () => {
    db.excludeTgChat("555", "Private Chat", "sensitive");
    expect(db.getExcludedTgChatIds().has("555")).toBe(true);
    db.includeTgChat("555");
    expect(db.getExcludedTgChatIds().has("555")).toBe(false);
  });
});
