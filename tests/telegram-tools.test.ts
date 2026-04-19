/**
 * Tests for Telegram tool handlers (src/mcp/telegram-tools.ts).
 */
import { describe, test, expect } from "bun:test";
import {
  tgListChats,
  tgReadChat,
  tgSearchMessages,
  tgExcludeChat,
  tgIncludeChat,
  tgListExcluded,
} from "../src/mcp/telegram-tools";

// ─── Mock objects ─────────────────────────────────────────

const mockUserbot = {
  isConnected: () => true,
  listChats: async (limit: number) =>
    Array.from({ length: limit }, (_, i) => ({ id: `chat-${i}`, title: `Chat ${i}` })),
  readChat: async (chatId: string, limit: number) =>
    Array.from({ length: limit }, (_, i) => ({ id: i, chatId, text: `msg-${i}` })),
  searchMessages: async (query: string, limit: number) =>
    [{ id: 1, text: `Found: ${query}`, chatId: "chat-1" }],
} as any;

const disconnectedUserbot = {
  isConnected: () => false,
} as any;

const mockMemory = {
  excludeTgChat: (_chatId: string, _chatTitle: string, _reason: string) => {},
  includeTgChat: (_chatId: string) => {},
  getExcludedTgChats: () => [
    { chat_id: "chat-1", chat_title: "Private Chat", reason: "private" },
  ],
} as any;

// ─── Tests ────────────────────────────────────────────────

describe("Telegram tools — null userbot", () => {
  test("tgListChats returns error when userbot is null", async () => {
    const r = await tgListChats(null);
    expect(r.success).toBe(false);
    expect(r.error).toContain("not connected");
  });

  test("tgReadChat returns error when userbot is null", async () => {
    const r = await tgReadChat(null, "chat-1");
    expect(r.success).toBe(false);
    expect(r.error).toContain("not connected");
  });

  test("tgSearchMessages returns error when userbot is null", async () => {
    const r = await tgSearchMessages(null, "query");
    expect(r.success).toBe(false);
    expect(r.error).toContain("not connected");
  });
});

describe("Telegram tools — disconnected userbot", () => {
  test("tgListChats returns error when disconnected", async () => {
    const r = await tgListChats(disconnectedUserbot);
    expect(r.success).toBe(false);
    expect(r.error).toContain("not connected");
  });
});

describe("Telegram tools — connected userbot", () => {
  test("tgListChats returns chat list", async () => {
    const r = await tgListChats(mockUserbot, 5);
    expect(r.success).toBe(true);
    expect((r.data as unknown[]).length).toBe(5);
  });

  test("tgReadChat returns messages", async () => {
    const r = await tgReadChat(mockUserbot, "chat-42", 10);
    expect(r.success).toBe(true);
    const data = r.data as { chatId: string }[];
    expect(data.length).toBe(10);
    expect(data[0].chatId).toBe("chat-42");
  });

  test("tgSearchMessages returns results", async () => {
    const r = await tgSearchMessages(mockUserbot, "bun runtime");
    expect(r.success).toBe(true);
    const data = r.data as { text: string }[];
    expect(data[0].text).toContain("bun runtime");
  });
});

describe("Telegram tools — memory exclusion", () => {
  test("tgExcludeChat succeeds", () => {
    const r = tgExcludeChat(mockMemory, "chat-1", "Private Chat", "private");
    expect(r.success).toBe(true);
    expect((r.data as { excluded: string }).excluded).toBe("chat-1");
  });

  test("tgIncludeChat succeeds", () => {
    const r = tgIncludeChat(mockMemory, "chat-1");
    expect(r.success).toBe(true);
    expect((r.data as { included: string }).included).toBe("chat-1");
  });

  test("tgListExcluded returns list", () => {
    const r = tgListExcluded(mockMemory);
    expect(r.success).toBe(true);
    const data = r.data as { chat_id: string }[];
    expect(data.length).toBe(1);
    expect(data[0].chat_id).toBe("chat-1");
  });

  test("tgExcludeChat with default reason", () => {
    const r = tgExcludeChat(mockMemory, "chat-2", "Work Chat");
    expect(r.success).toBe(true);
    expect((r.data as { reason: string }).reason).toBe("private");
  });
});

describe("Telegram tools — error handling", () => {
  test("tgExcludeChat catches thrown errors", () => {
    const brokenMemory = {
      excludeTgChat: () => {
        throw new Error("DB write failed");
      },
    } as any;
    const r = tgExcludeChat(brokenMemory, "c", "t");
    expect(r.success).toBe(false);
    expect(r.error).toBe("DB write failed");
  });

  test("tgListExcluded catches non-Error throws", () => {
    const brokenMemory = {
      getExcludedTgChats: () => {
        throw "string error";
      },
    } as any;
    const r = tgListExcluded(brokenMemory);
    expect(r.success).toBe(false);
    expect(r.error).toBe("string error");
  });
});

console.log("🎉 Telegram tools tests passed!");
