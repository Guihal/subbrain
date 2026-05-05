import { describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import {
  compressContext,
  SOFT_LIMIT,
  shouldCompress,
} from "@subbrain/agent/pipeline/context-compressor";
import { MemoryDB } from "@subbrain/core/db";
import type { ChatResponse, Message } from "../src/providers/types";

const TEST_DB = "data/test-compressor.db";

function bigMessages(n: number, charsEach: number): Message[] {
  const out: Message[] = [
    { role: "system", content: "you are test" },
    { role: "user", content: "original task" },
  ];
  for (let i = 0; i < n; i++) {
    out.push({ role: "assistant", content: "A".repeat(charsEach) });
    out.push({ role: "user", content: "B".repeat(charsEach) });
  }
  return out;
}

function mkRouter(reply: string) {
  return {
    chat: async (): Promise<ChatResponse> => ({
      id: "r",
      object: "chat.completion",
      created: 0,
      model: "flash",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: reply },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  } as any;
}

describe("context-compressor", () => {
  test("shouldCompress flips past SOFT_LIMIT", () => {
    const small: Message[] = [{ role: "user", content: "hi" }];
    expect(shouldCompress(small)).toBe(false);
    const huge = bigMessages(200, 2000); // well past SOFT_LIMIT
    expect(shouldCompress(huge)).toBe(true);
  });

  test("collapses middle, preserves head+tail, writes facts", async () => {
    try {
      unlinkSync(TEST_DB);
    } catch {}
    const memory = new MemoryDB(TEST_DB);
    const messages = bigMessages(200, 2000);
    const before = messages.length;

    const router = mkRouter(
      JSON.stringify({
        summary: "compressed recap",
        facts: [
          { category: "finding", content: "earth is round" },
          { category: "user", content: "likes caveman mode" },
        ],
      }),
    );

    const ok = await compressContext(messages, router, memory);
    expect(ok).toBe(true);
    expect(messages.length).toBeLessThan(before);

    // Head (system + first user) kept verbatim
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toBe("you are test");
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toBe("original task");

    // Injected summary
    const hasSummary = messages.some(
      (m) => m.role === "system" && (m.content ?? "").includes("compressed recap"),
    );
    expect(hasSummary).toBe(true);

    // Facts persisted
    const shared = memory.searchShared("earth", 10);
    expect(shared.length).toBeGreaterThan(0);
  });

  test("returns false + leaves messages untouched on flash failure", async () => {
    const messages = bigMessages(200, 2000);
    const snapshot = [...messages];
    const router = {
      chat: async () => {
        throw new Error("upstream down");
      },
    } as any;

    const ok = await compressContext(messages, router, null);
    expect(ok).toBe(false);
    expect(messages.length).toBe(snapshot.length);
  });

  test("no-op below SOFT_LIMIT", async () => {
    const messages: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "short question" },
    ];
    const router = mkRouter("should not be called");
    const ok = await compressContext(messages, router, null);
    expect(ok).toBe(false);
    expect(messages.length).toBe(2);
  });

  test("SOFT_LIMIT exported constant is sane", () => {
    expect(SOFT_LIMIT).toBeGreaterThan(10_000);
  });
});
