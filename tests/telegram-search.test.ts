import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { MemoryDB } from "@subbrain/core/db";

const TEST_DB = "data/test-telegram-search.db";

function fresh(): MemoryDB {
  try {
    unlinkSync(TEST_DB);
  } catch {}
  return new MemoryDB(TEST_DB);
}

describe("searchTgMessages (FTS)", () => {
  let memory: MemoryDB;

  beforeEach(() => {
    memory = fresh();
    memory.insertTgMessages([
      {
        message_id: 1,
        chat_id: "42",
        chat_name: "DevChat",
        from_name: "Alice",
        ts: 1_700_000_000,
        text: "нужно починить billing webhook срочно",
      },
      {
        message_id: 2,
        chat_id: "42",
        chat_name: "DevChat",
        from_name: "Bob",
        ts: 1_700_000_100,
        text: "обсудили деплой на прод",
      },
      {
        message_id: 3,
        chat_id: "99",
        chat_name: "Family",
        from_name: "Mom",
        ts: 1_700_000_200,
        text: "не забудь купить хлеб",
      },
    ]);
  });

  afterEach(() => {
    memory.close();
    try {
      unlinkSync(TEST_DB);
    } catch {}
  });

  test("finds by token", () => {
    const r = memory.searchTgMessages({ query: "billing" });
    expect(r.total).toBe(1);
    expect(r.items[0].message_id).toBe(1);
  });

  test("filter by chat_id", () => {
    const r = memory.searchTgMessages({ query: "хлеб", chatId: "42" });
    expect(r.total).toBe(0);
  });

  test("filter by time range (ts)", () => {
    const r = memory.searchTgMessages({
      query: "деплой",
      from: 1_700_000_050,
      to: 1_700_000_150,
    });
    expect(r.total).toBe(1);
    expect(r.items[0].message_id).toBe(2);
  });

  test("empty query → empty result", () => {
    const r = memory.searchTgMessages({ query: "  " });
    expect(r.total).toBe(0);
    expect(r.items).toEqual([]);
  });

  test("sanitizes operator injection", () => {
    const r = memory.searchTgMessages({ query: 'billing" OR 1=1' });
    expect(r.total).toBe(1);
  });

  test("insert is idempotent on (chat_id, message_id) pk", () => {
    memory.insertTgMessages([
      {
        message_id: 1,
        chat_id: "42",
        chat_name: "DevChat",
        from_name: "Alice",
        ts: 1_700_000_000,
        text: "новый текст не должен заменить старый",
      },
    ]);
    expect(memory.countTgMessages()).toBe(3);
  });
});
