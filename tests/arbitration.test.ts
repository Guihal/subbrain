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

import { ArbitrationRoom } from "../src/pipeline/arbitration";
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

// ─── Test 9: One specialist throws hard → others still synthesize ─

chatCalls = [];
let callIdx = 0;
const mockRouterOneThrows = {
  chat: async (model: string, params: any) => {
    chatCalls.push({ model, messages: params.messages });
    callIdx++;
    // Second call (middle specialist) throws a non-timeout error
    if (model !== "teamlead" && callIdx === 2) {
      throw new Error("upstream 500");
    }
    if (model === "teamlead") return makeResponse("Synth after partial fail.");
    return makeResponse(`${model} ok`);
  },
} as any;
const roomPartial2 = new ArbitrationRoom(mockRouterOneThrows);
const result4 = await roomPartial2.run("x", "", {
  agents: ["coder", "critic", "generalist"],
  category: "architecture",
  timeout: 500,
});
console.assert(
  result4.synthesis === "Synth after partial fail.",
  `allSettled should synthesize with N-1, got: ${result4.synthesis}`,
);
console.assert(
  result4.agentResponses.filter((r) => r.content.length > 0).length === 2,
  "Exactly 2 of 3 specialists should have content",
);

// ─── Test 10: Synthesis timeout → top-2 fallback ─────────
//
// Specialists return fast, but teamlead synthesis hangs past
// SYNTHESIS_TIMEOUT_MS (set to 100ms via env). Expect a fallback string with
// the "Synthesis timed out" marker and content from the 2 highest-weighted
// specialists for category "review" (critic 1.5, coder 0.8 → both, in that
// order).

process.env.SYNTHESIS_TIMEOUT_MS = "100";
// Re-import to pick up the new env value (module-level const).
// Re-import the type module so SYNTHESIS_TIMEOUT picks up the new env value.
const { ArbitrationRoom: ArbitrationRoomT } = await import(
  "../src/pipeline/arbitration/index.ts?t=" + Date.now()
);

chatCalls = [];
const mockRouterSlowSynth = {
  chat: async (model: string, params: any) => {
    chatCalls.push({ model, messages: params.messages });
    if (model === "teamlead") {
      // Hang well past SYNTHESIS_TIMEOUT_MS so the race resolves to timeout.
      await new Promise((r) => setTimeout(r, 1000));
      return makeResponse("Slow synth that should have been aborted.");
    }
    if (model === "coder") return makeResponse("Coder: use locks.");
    if (model === "critic") return makeResponse("Critic: deadlock risk.");
    return makeResponse("?");
  },
} as any;
const roomSlowSynth = new ArbitrationRoomT(mockRouterSlowSynth);
const t0 = Date.now();
const result5 = await roomSlowSynth.run(
  "Should we add locks?",
  "",
  { agents: ["coder", "critic"], category: "review", timeout: 1000 },
);
const elapsed = Date.now() - t0;
console.assert(
  result5.synthesis.startsWith("⚠ Synthesis timed out"),
  `Expected timeout marker, got: ${result5.synthesis.slice(0, 80)}`,
);
console.assert(
  result5.synthesis.includes("Critic: deadlock risk."),
  "Fallback should contain critic content (highest weight in review)",
);
console.assert(
  result5.synthesis.includes("Coder: use locks."),
  "Fallback should contain coder content (top-2)",
);
// Critic comes before coder in the fallback because critic has higher
// review-weight (1.5 vs 0.8).
const criticPos = result5.synthesis.indexOf("Critic:");
const coderPos = result5.synthesis.indexOf("Coder:");
console.assert(
  criticPos > 0 && criticPos < coderPos,
  `Top-2 should be ranked by weight: critic before coder, got positions ${criticPos}/${coderPos}`,
);
// Race must resolve roughly at SYNTHESIS_TIMEOUT_MS, NOT at the 1000ms hang.
console.assert(
  elapsed < 600,
  `Run should return at synthesis timeout (~100ms), elapsed ${elapsed}ms`,
);
delete process.env.SYNTHESIS_TIMEOUT_MS;

console.log("✅ All 10 arbitration tests passed");
