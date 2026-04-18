/**
 * Agent Pipeline unit tests.
 *
 * Tests:
 * - Pipeline routing (virtual model → pipeline, real model → direct)
 * - Pre-processing: focus injection, RAG context assembly
 * - Post-processing: logging to Layer 4, knowledge extraction
 * - First message vs continuation detection
 * - Short query bypass
 *
 * Uses mock router (no live API calls).
 */

import { AgentPipeline } from "../src/pipeline";
import { RAGPipeline } from "../src/rag";
import { MemoryDB } from "../src/db";
import { unlinkSync } from "fs";
import type { ChatResponse, Message } from "../src/providers/types";

const TEST_DB = "data/test-pipeline.db";
try {
  unlinkSync(TEST_DB);
} catch {}

const memory = new MemoryDB(TEST_DB);

// ─── Mock router ─────────────────────────────────────────

let chatCalls: { model: string; messages: Message[] }[] = [];

const mockResponse: ChatResponse = {
  id: "test-id",
  object: "chat.completion",
  created: Date.now(),
  model: "mock",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "Mock response" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

// Flash response for pre-processing (executive summary)
const flashSummaryResponse: ChatResponse = {
  ...mockResponse,
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: "Executive summary: the project uses Bun + Elysia.",
      },
      finish_reason: "stop",
    },
  ],
};

// Flash response for post-processing (knowledge extraction)
const flashDeltaResponse: ChatResponse = {
  ...mockResponse,
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: '{"facts": [], "skip": true}',
      },
      finish_reason: "stop",
    },
  ],
};

const mockRouter = {
  chat: async (model: string, params: any, priority?: string) => {
    chatCalls.push({ model, messages: params.messages });
    // Return different responses based on the calling pattern
    if (model === "flash") {
      // Check if it's pre-processing (context assembler) or post-processing (knowledge extractor)
      const systemMsg = params.messages?.[0]?.content || "";
      if (systemMsg.includes("context assembler")) return flashSummaryResponse;
      if (systemMsg.includes("knowledge extractor")) return flashDeltaResponse;
      return flashSummaryResponse;
    }
    return mockResponse;
  },
  chatStream: async () => {
    return new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"choices":[{"delta":{"content":"streamed"}}]}\n\n',
          ),
        );
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
  },
  scheduleRaw: async (_p: string, fn: () => Promise<any>) => fn(),
  raw: {
    embed: async () => ({
      data: [{ embedding: new Array(2048).fill(0) }],
    }),
    rerank: async () => ({
      results: [{ index: 0, relevance_score: 0.9 }],
    }),
  },
} as any;

const rag = new RAGPipeline(memory, mockRouter);
const pipeline = new AgentPipeline(memory, mockRouter, rag);

// ─── Seed test data ──────────────────────────────────────

memory.setFocus("identity", "I am the TeamLead AI");
memory.setFocus("directive", "Help build the subbrain project");

memory.insertContext(
  "ctx-test-1",
  "Stack Choice",
  "We chose Bun + Elysia for the server runtime because of performance",
  "bun,elysia,architecture",
);

// ─── Test 1: First message → full pipeline with pre-processing ──

chatCalls = [];
const result1 = await pipeline.execute({
  model: "teamlead",
  messages: [
    {
      role: "user",
      content:
        "Why did we choose Bun and Elysia for the server runtime architecture?",
    },
  ],
});

console.assert(result1.requestId.length > 0, "Should have requestId");
console.assert(result1.sessionId.length > 0, "Should have sessionId");
console.assert(result1.response !== undefined, "Should have response");
console.assert(result1.stream === undefined, "Should NOT have stream");

// Should have called flash for pre-processing + main model for response
console.assert(
  chatCalls.length >= 2,
  `Expected ≥2 chat calls, got ${chatCalls.length}`,
);
console.assert(
  chatCalls[0].model === "flash",
  `First call should be flash (pre-processing), got ${chatCalls[0].model}`,
);
console.assert(
  chatCalls[1].model === "teamlead",
  `Second call should be teamlead (main), got ${chatCalls[1].model}`,
);

// System prompt should contain focus entries
const mainMessages = chatCalls[1].messages;
const systemMsg = mainMessages.find((m) => m.role === "system")?.content || "";
console.assert(
  systemMsg.includes("TeamLead"),
  "System prompt should include identity focus",
);
console.assert(
  systemMsg.includes("Executive summary") || systemMsg.includes("Context"),
  "System prompt should include executive summary",
);
console.log("✅ Test 1: First message → full pre-processing pipeline");

// ─── Test 2: Continuation (has assistant history) → skip pre-processing

chatCalls = [];
const result2 = await pipeline.execute({
  model: "coder",
  messages: [
    { role: "user", content: "Write the initial code" },
    { role: "assistant", content: "Here is the code..." },
    { role: "user", content: "Now add error handling" },
  ],
});

console.assert(result2.response !== undefined, "Should have response");
// Should NOT call flash for pre-processing (continuation chat)
console.assert(
  chatCalls.length === 1,
  `Continuation should skip pre-processing, got ${chatCalls.length} calls`,
);
console.assert(
  chatCalls[0].model === "coder",
  "Should go directly to main model",
);
console.log("✅ Test 2: Continuation → skip pre-processing");

// ─── Test 3: Short first message → focus only, no RAG

chatCalls = [];
const result3 = await pipeline.execute({
  model: "coder",
  messages: [{ role: "user", content: "Fix the bug" }],
});

console.assert(result3.response !== undefined, "Should have response");
// Short query: inject focus but skip RAG (no flash call for summary)
console.assert(
  chatCalls.length === 1,
  `Short query: expected 1 call, got ${chatCalls.length}`,
);
// But system prompt should still have focus entries
const shortSysMsg =
  chatCalls[0].messages.find((m) => m.role === "system")?.content || "";
console.assert(
  shortSysMsg.includes("TeamLead"),
  "Short query should still get focus injection",
);
console.log("✅ Test 3: Short first message → focus only, no RAG");

// ─── Test 4: Streaming response

chatCalls = [];
const result4 = await pipeline.execute({
  model: "teamlead",
  messages: [
    {
      role: "user",
      content:
        "Why did we choose Bun and Elysia for the performance of the server runtime?",
    },
  ],
  stream: true,
});

console.assert(result4.stream !== undefined, "Should have stream");
console.assert(result4.response === undefined, "Should NOT have response");
console.assert(result4.requestId.length > 0, "Should have requestId");

// Consume the stream
const reader = result4.stream!.getReader();
const chunks: string[] = [];
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  chunks.push(new TextDecoder().decode(value));
}
console.assert(chunks.length > 0, "Stream should produce chunks");
console.log("✅ Test 4: Streaming pipeline");

// ─── Test 5: Post-processing logs to Layer 4

// Wait a tick for fire-and-forget post-processing
await new Promise((r) => setTimeout(r, 100));

const logs = memory.getLogsByRequest(result1.requestId);
console.assert(logs.length >= 2, `Expected ≥2 log entries, got ${logs.length}`);
console.assert(
  logs.some((l) => l.role === "user"),
  "Should log user message",
);
console.assert(
  logs.some((l) => l.role === "assistant"),
  "Should log assistant message",
);
console.log("✅ Test 5: Post-processing writes to Layer 4");

// ─── Test 6: Explicit session ID passed through

chatCalls = [];
const result6 = await pipeline.execute({
  model: "coder",
  messages: [
    { role: "assistant", content: "prev" },
    { role: "user", content: "More code please" },
  ],
  sessionId: "my-session-123",
});
console.assert(
  result6.sessionId === "my-session-123",
  "Should preserve explicit sessionId",
);
console.log("✅ Test 6: Explicit sessionId");

// ─── Cleanup ─────────────────────────────────────────────
try {
  unlinkSync(TEST_DB);
} catch {}

console.log("\n🎉 All Agent Pipeline tests passed!");
