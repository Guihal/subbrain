import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { MemoryDB } from "../packages/core/src/db";

describe("TgMessagesTable PII search guard", () => {
  let memory: MemoryDB;

  beforeEach(() => {
    memory = new MemoryDB(":memory:");
  });

  afterEach(() => {
    memory.close();
  });

  test("happy path search returns hits", () => {
    memory.insertTgMessage({ message_id: 1, chat_id: "c1", ts: 1000, text: "hello world" });
    const result = memory.searchTgMessages({ query: "hello" });
    expect(result.items).toHaveLength(1);
    expect(result.total).toBe(1);
  });

  test("blocks REDACTED: query", () => {
    expect(() => memory.searchTgMessages({ query: "REDACTED:email" })).toThrow("pii_query_blocked");
  });

  test("blocks mixed-case redacted: query", () => {
    expect(() => memory.searchTgMessages({ query: "Redacted:Phone" })).toThrow("pii_query_blocked");
  });

  test("scrubbed text is indexed and findable", () => {
    memory.insertTgMessage({ message_id: 2, chat_id: "c1", ts: 2000, text: "call me at +7 901 555 0101" });
    const recent = memory.recentTgMessages("c1", 1);
    expect(recent[0].text).toContain("[REDACTED:phone]");
    const result = memory.searchTgMessages({ query: "call" });
    expect(result.items).toHaveLength(1);
    expect(result.total).toBe(1);
  });
});
