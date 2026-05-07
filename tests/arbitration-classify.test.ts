/**
 * ArbitrationRoom — classification heuristic tests.
 *
 * Pure-function tests on `ArbitrationRoom.classify()`; no router/network.
 * Split out of the legacy `arbitration.test.ts` (script-style → bun:test).
 */

import { describe, expect, test } from "bun:test";
import { ArbitrationRoom } from "@subbrain/agent/pipeline/arbitration";

const room = new ArbitrationRoom({ chat: async () => ({}) as never } as never);

describe("ArbitrationRoom.classify", () => {
  test("returns null for simple requests", () => {
    expect(room.classify("fix the typo")).toBeNull();
    expect(room.classify("напиши функцию сортировки")).toBeNull();
  });

  // Architecture path includes `chaos` since classify.ts dispatches 4 agents
  // (coder/critic/generalist/chaos). Legacy test asserted 3 — stale; surfaced
  // by the bun:test migration (console.assert was silently green).
  test("detects architecture questions → 4 agents", () => {
    const arch = room.classify("какой подход лучше — Redis или SQLite?");
    expect(arch).not.toBeNull();
    expect(arch?.category).toBe("architecture");
    expect(arch?.agents.length).toBe(4);
    expect(arch?.agents).toEqual(["coder", "critic", "generalist", "chaos"]);
  });

  test("detects review requests → 2 agents", () => {
    const review = room.classify("проверь этот код на баги");
    expect(review).not.toBeNull();
    expect(review?.category).toBe("review");
    expect(review?.agents.length).toBe(2);
  });

  test("detects explicit triggers (RU)", () => {
    const explicit = room.classify("обсудите best practices для error handling");
    expect(explicit).not.toBeNull();
  });

  test("detects explicit triggers (EN)", () => {
    const explicitEn = room.classify("compare approaches for caching and storage");
    expect(explicitEn).not.toBeNull();
  });
});
