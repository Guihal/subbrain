/**
 * ArbitrationRoom — happy-path parallel dispatch + synthesis.
 *
 * 3 specialists (coder/critic/generalist) → teamlead synthesis. Verifies
 * call fan-out, result shape, and latency metadata. Mock router only.
 *
 * Split out of legacy `arbitration.test.ts` (script-style → bun:test).
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { ArbitrationRoom } from "@subbrain/agent/pipeline/arbitration";
import {
  type Call,
  happyRouter,
} from "./helpers/arbitration-mocks";

describe("ArbitrationRoom.run — happy path (3 specialists + synthesis)", () => {
  const calls: Call[] = [];
  const room = new ArbitrationRoom(happyRouter(calls));
  let result: Awaited<ReturnType<typeof room.run>>;

  beforeEach(async () => {
    calls.length = 0;
    result = await room.run("Какой подход лучше для кеша?", "We use SQLite.", {
      agents: ["coder", "critic", "generalist"],
      category: "architecture",
      timeout: 5000,
    });
  });

  test("dispatches 3 specialists + 1 synthesis call", () => {
    expect(calls.length).toBe(4);
    const models = calls.map((c) => c.model);
    expect(models).toContain("coder");
    expect(models).toContain("critic");
    expect(models).toContain("generalist");
    expect(models).toContain("teamlead");
  });

  test("returns synthesis content + agent responses + category", () => {
    expect(result.synthesis).toBe("Synthesized answer from team.");
    expect(result.agentResponses.length).toBe(3);
    expect(result.category).toBe("architecture");
  });

  test("agent responses carry latency + no timeouts", () => {
    expect(result.agentResponses.every((r) => r.latencyMs >= 0)).toBe(true);
    expect(result.agentResponses.every((r) => r.timedOut === false)).toBe(true);
  });
});
