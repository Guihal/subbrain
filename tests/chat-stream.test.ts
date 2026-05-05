import { describe, expect, test } from "bun:test";
import type { MemoryDB } from "@subbrain/core/db";
import { wrapStreamForChat } from "../src/routes/chat";

function sseChunk(content: string): Uint8Array {
  const payload = JSON.stringify({
    choices: [{ delta: { content } }],
  });
  return new TextEncoder().encode(`data: ${payload}\n\n`);
}

function makeUpstream(chunks: Uint8Array[], onCancel: () => void) {
  let idx = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      // Space chunks out so the consumer can cancel mid-stream.
      await new Promise((r) => setTimeout(r, 5));
      if (idx >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[idx++]);
    },
    cancel() {
      onCancel();
    },
  });
}

function mockMemory(): MemoryDB & { appended: number } {
  let appended = 0;
  const stub = {
    appendChatMessage: (_chatId: string, _role: string, _text: string) => {
      appended++;
    },
    get appended() {
      return appended;
    },
  } as unknown as MemoryDB & { appended: number };
  return stub;
}

describe("wrapStreamForChat — HIGH-9 write-after-close guard", () => {
  test("client cancel after 2 chunks → no DB append", async () => {
    const mem = mockMemory();
    let upstreamCancelled = false;
    const upstream = makeUpstream(
      [sseChunk("hello "), sseChunk("world "), sseChunk("extra")],
      () => {
        upstreamCancelled = true;
      },
    );

    const wrapped = wrapStreamForChat(upstream, mem, "chat-1", "coder");
    const reader = wrapped.getReader();

    await reader.read();
    await reader.read();
    await reader.cancel("client disconnect");

    // Give any lingering microtasks a chance to run.
    await new Promise((r) => setTimeout(r, 50));

    expect(mem.appended).toBe(0);
    expect(upstreamCancelled).toBe(true);
  });

  test("normal completion → DB append runs", async () => {
    const mem = mockMemory();
    const upstream = makeUpstream([sseChunk("hi"), sseChunk("!")], () => {});
    const wrapped = wrapStreamForChat(upstream, mem, "chat-2", "coder");
    const reader = wrapped.getReader();

    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
    await new Promise((r) => setTimeout(r, 10));

    expect(mem.appended).toBe(1);
  });
});
