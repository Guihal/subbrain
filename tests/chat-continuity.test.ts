import { describe, test, expect, beforeEach } from "bun:test";
import { unlinkSync } from "fs";
import { Elysia } from "elysia";
import { MemoryDB } from "../src/db";
import { chatRoute } from "../src/routes/chat";
import type { ChatResponse } from "../src/providers/types";

const TEST_DB = "data/test-chat-continuity.db";

function mkRouter(onChat: (messages: any[]) => void) {
  return {
    isOverloaded: false,
    isOverloadedFor: () => false,
    chat: async (_model: string, params: any): Promise<ChatResponse> => {
      onChat(params.messages);
      return {
        id: "r", object: "chat.completion", created: 0, model: "flash",
        choices: [{
          index: 0, finish_reason: "stop",
          message: { role: "assistant", content: "reply-2" },
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
    },
    chatStream: async () => { throw new Error("unused"); },
  } as any;
}

describe("chat continuity (A2)", () => {
  beforeEach(() => { try { unlinkSync(TEST_DB); } catch {} });

  test("hydrates history from chats table when client sends only last user msg", async () => {
    const memory = new MemoryDB(TEST_DB);
    // Seed chat with prior turn
    memory.createChat("c1", "t", "flash", "api");
    memory.appendChatMessage("c1", "user", "first");
    memory.appendChatMessage("c1", "assistant", "reply-1", { model: "flash" });

    let seen: any[] = [];
    const router = mkRouter((m) => { seen = m; });
    const app = new Elysia().use(chatRoute(router, undefined, memory));

    const res = await app.handle(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", "x-chat-id": "c1" },
        body: JSON.stringify({
          model: "flash",
          messages: [{ role: "user", content: "second" }],
        }),
      }),
    );
    expect(res.status).toBe(200);
    const roles = seen.map((m) => m.role);
    // Expect user/assistant/user at minimum — history rehydrated
    expect(roles).toContain("assistant");
    const lastUsers = seen.filter((m) => m.role === "user");
    expect(lastUsers.length).toBeGreaterThanOrEqual(2);
  });

  test("does NOT hydrate when client sends full history already", async () => {
    const memory = new MemoryDB(TEST_DB);
    memory.createChat("c2", "t", "flash", "api");
    memory.appendChatMessage("c2", "user", "first");
    memory.appendChatMessage("c2", "assistant", "reply-1", { model: "flash" });

    let seen: any[] = [];
    const router = mkRouter((m) => { seen = m; });
    const app = new Elysia().use(chatRoute(router, undefined, memory));

    const res = await app.handle(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", "x-chat-id": "c2" },
        body: JSON.stringify({
          model: "flash",
          messages: [
            { role: "user", content: "first" },
            { role: "assistant", content: "reply-1" },
            { role: "user", content: "second" },
          ],
        }),
      }),
    );
    expect(res.status).toBe(200);
    // Already has assistant in payload → no hydration → exactly 3 msgs passed through
    expect(seen.length).toBe(3);
  });
});
