import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { applyAtIngest } from "@subbrain/agent/services/tg-ingest";
import { MemoryDB } from "@subbrain/core/db";

const TEST_DB = "data/test-tg-ingest.db";

function fresh(): MemoryDB {
  try {
    unlinkSync(TEST_DB);
  } catch {}
  return new MemoryDB(TEST_DB);
}

describe("applyAtIngest", () => {
  test("scrubs email from text", () => {
    const row = applyAtIngest({
      message_id: 1,
      chat_id: "1",
      ts: 1,
      text: "contact me at alice@example.com",
    });
    expect(row.text).toBe("contact me at [REDACTED:email]");
  });

  test("scrubs phone from text", () => {
    const row = applyAtIngest({
      message_id: 2,
      chat_id: "1",
      ts: 1,
      text: "call +7 901 555 0101",
    });
    expect(row.text).toContain("[REDACTED:phone]");
  });

  test("passes through clean text unchanged", () => {
    const clean = "just a normal message";
    const row = applyAtIngest({
      message_id: 3,
      chat_id: "1",
      ts: 1,
      text: clean,
    });
    expect(row.text).toBe(clean);
  });

  test("preserves other fields", () => {
    const row = applyAtIngest({
      message_id: 42,
      chat_id: "99",
      chat_name: "Dev",
      from_name: "Bob",
      ts: 1_700_000_000,
      text: "hello",
    });
    expect(row.message_id).toBe(42);
    expect(row.chat_id).toBe("99");
    expect(row.chat_name).toBe("Dev");
    expect(row.from_name).toBe("Bob");
    expect(row.ts).toBe(1_700_000_000);
  });
});

describe("TgMessagesTable.insert scrub", () => {
  let memory: MemoryDB;

  beforeEach(() => {
    memory = fresh();
  });

  afterEach(() => {
    memory.close();
    try {
      unlinkSync(TEST_DB);
    } catch {}
  });

  test("insert scrubs PII before SQL", () => {
    memory.insertTgMessage({
      message_id: 1,
      chat_id: "1",
      ts: 1,
      text: "email me at bob@test.com",
    });
    const rows = memory.recentTgMessages("1", 1);
    expect(rows[0].text).toBe("email me at [REDACTED:email]");
  });

  test("insertMany delegates to insert and scrubs", () => {
    memory.insertTgMessages([
      {
        message_id: 1,
        chat_id: "1",
        ts: 1,
        text: "passport 4515 123456",
      },
      {
        message_id: 2,
        chat_id: "1",
        ts: 2,
        text: "clean text",
      },
    ]);
    const rows = memory.recentTgMessages("1", 10);
    expect(rows.length).toBe(2);
    const r1 = rows.find((r) => r.message_id === 1);
    const r2 = rows.find((r) => r.message_id === 2);
    expect(r1?.text).toBe("passport [REDACTED:passport_ru]");
    expect(r2?.text).toBe("clean text");
  });
});
