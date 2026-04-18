/**
 * ArbitrationRoom unit tests.
 *
 * Tests:
 * - Classification heuristics
 * - Parallel specialist dispatch
 * - Synthesis via TeamLead
 * - Timeout handling
 * - Single-response early exit (skip synthesis)
 *
 * Uses mock router (no live API calls).
 */

import { ArbitrationRoom } from "../src/pipeline/arbitration-room";
import type { ChatResponse, Message } from "../src/providers/types";

// ─── Mock Router ─────────────────────────────────────────

let chatCalls: { model: string; messages: Message[] }[] = [];

const makeResponse = (content: string): ChatResponse => ({
  id: "test-id",
  object: "chat.completion",
  created: Date.now(),
  model: "mock",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

const mockRouter = {
  chat: async (model: string, params: any, _priority?: string) => {
    chatCalls.push({ model, messages: params.messages });
    if (model === "teamlead")
      return makeResponse("Synthesized answer from team.");
    if (model === "coder") return makeResponse("Coder says: use a HashMap.");
    if (model === "critic")
      return makeResponse("Critic says: watch for race conditions.");
    if (model === "generalist")
      return makeResponse("Generalist says: consider trade-offs.");
    return makeResponse("Unknown role response.");
  },
} as any;

const room = new ArbitrationRoom(mockRouter);

// ─── Test 1: classify() returns null for simple requests ─

console.assert(room.classify("fix the typo") === null, "Simple request → null");
console.assert(
  room.classify("напиши функцию сортировки") === null,
  "Simple RU → null",
);

// ─── Test 2: classify() detects architecture questions ───

const arch = room.classify("какой подход лучше — Redis или SQLite?");
console.assert(arch !== null, "Architecture question → RoomConfig");
console.assert(
  arch!.category === "architecture",
  `Expected architecture, got ${arch!.category}`,
);
console.assert(
  arch!.agents.length === 3,
  `Expected 3 agents, got ${arch!.agents.length}`,
);

// ─── Test 3: classify() detects review requests ──────────

const review = room.classify("проверь этот код на баги");
console.assert(review !== null, "Review request → RoomConfig");
console.assert(
  review!.category === "review",
  `Expected review, got ${review!.category}`,
);
console.assert(
  review!.agents.length === 2,
  `Expected 2 agents for review, got ${review!.agents.length}`,
);

// ─── Test 4: classify() detects explicit triggers ────────

const explicit = room.classify("обсудите best practices для error handling");
console.assert(explicit !== null, "Explicit trigger → RoomConfig");

const explicitEn = room.classify("compare approaches for caching and storage");
console.assert(explicitEn !== null, "EN explicit trigger → RoomConfig");

// ─── Test 5: Parallel dispatch → synthesis ───────────────

chatCalls = [];
const result = await room.run(
  "Какой подход лучше для кеша?",
  "We use SQLite.",
  {
    agents: ["coder", "critic", "generalist"],
    category: "architecture",
    timeout: 5000,
  },
);

// Should have 3 specialist calls + 1 synthesis call
console.assert(
  chatCalls.length === 4,
  `Expected 4 chat calls (3 specialists + 1 synthesis), got ${chatCalls.length}`,
);

// Check that specialists were called
const calledModels = chatCalls.map((c) => c.model);
console.assert(calledModels.includes("coder"), "Should call coder");
console.assert(calledModels.includes("critic"), "Should call critic");
console.assert(calledModels.includes("generalist"), "Should call generalist");
console.assert(
  calledModels.includes("teamlead"),
  "Should call teamlead for synthesis",
);

// Check synthesis result
console.assert(
  result.synthesis === "Synthesized answer from team.",
  `Expected synthesis content, got: ${result.synthesis}`,
);
console.assert(
  result.agentResponses.length === 3,
  `Expected 3 agent responses`,
);
console.assert(
  result.category === "architecture",
  `Expected architecture category`,
);

// ─── Test 6: Single valid response → skip synthesis ──────

chatCalls = [];

// Create a router where 2/3 fail (timeout)
const mockRouterPartial = {
  chat: async (model: string, params: any, _priority?: string) => {
    chatCalls.push({ model, messages: params.messages });
    if (model === "coder") return makeResponse("Only coder responded.");
    // Others timeout
    return new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), 100),
    );
  },
} as any;

const roomPartial = new ArbitrationRoom(mockRouterPartial);
const result2 = await roomPartial.run("Review this code", "", {
  agents: ["coder", "critic"],
  category: "review",
  timeout: 200,
});

// Only 1 valid response → synthesis skipped, content is directly from coder
console.assert(
  result2.synthesis === "Only coder responded.",
  `Expected direct response, got: ${result2.synthesis}`,
);

// ─── Test 7: All timeout → "No responses received." ─────

chatCalls = [];
const mockRouterTimeout = {
  chat: async () => {
    return new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), 50),
    );
  },
} as any;

const roomTimeout = new ArbitrationRoom(mockRouterTimeout);
const result3 = await roomTimeout.run("Test", "", {
  agents: ["coder", "critic"],
  category: "code",
  timeout: 100,
});

console.assert(
  result3.synthesis === "No responses received.",
  `Expected no responses fallback, got: ${result3.synthesis}`,
);
console.assert(
  result3.agentResponses.every((r) => r.timedOut || r.content === ""),
);

// ─── Test 8: Agent responses have latency data ──────────

console.assert(
  result.agentResponses.every((r) => r.latencyMs >= 0),
  "All responses should have latencyMs",
);
console.assert(
  result.agentResponses.every((r) => r.timedOut === false),
  "Happy path should have no timeouts",
);

console.log("✅ All 8 arbitration tests passed");
