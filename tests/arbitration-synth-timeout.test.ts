/**
 * ArbitrationRoom — synthesis-stage timeout → top-2 fallback.
 *
 * Specialists return fast, but teamlead synthesis hangs past
 * `SYNTHESIS_TIMEOUT_MS`. Result must carry the "⚠ Synthesis timed out"
 * marker + content from the 2 highest-weighted specialists for the
 * category (review: critic 1.5 > coder 0.8). Race must resolve near the
 * synthesis timeout, not at the underlying hang.
 *
 * `getSynthesisTimeout()` reads `process.env.SYNTHESIS_TIMEOUT_MS` at
 * call time, so env snapshot/restore via beforeEach/afterEach is enough
 * — no dynamic re-import needed (legacy hack removed).
 *
 * Split out of legacy `arbitration.test.ts` (script-style → bun:test).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ArbitrationRoom } from "@subbrain/agent/pipeline/arbitration";
import type { Message } from "@subbrain/core/types/providers";
import { makeResponse } from "./helpers/arbitration-mocks";

describe("ArbitrationRoom.run — synthesis timeout → top-2 fallback", () => {
  let prevTimeout: string | undefined;

  beforeEach(() => {
    prevTimeout = process.env.SYNTHESIS_TIMEOUT_MS;
    process.env.SYNTHESIS_TIMEOUT_MS = "100";
  });
  afterEach(() => {
    if (prevTimeout === undefined) delete process.env.SYNTHESIS_TIMEOUT_MS;
    else process.env.SYNTHESIS_TIMEOUT_MS = prevTimeout;
  });

  test("returns timeout marker + top-2 by review weight (critic > coder)", async () => {
    const router = {
      chat: async (model: string, _params: { messages: Message[] }) => {
        if (model === "teamlead") {
          await new Promise((r) => setTimeout(r, 1000));
          return makeResponse("Slow synth that should have been aborted.");
        }
        if (model === "coder") return makeResponse("Coder: use locks.");
        if (model === "critic") return makeResponse("Critic: deadlock risk.");
        return makeResponse("?");
      },
    } as never;
    const room = new ArbitrationRoom(router);
    const t0 = Date.now();
    const result = await room.run("Should we add locks?", "", {
      agents: ["coder", "critic"],
      category: "review",
      timeout: 1000,
    });
    const elapsed = Date.now() - t0;

    expect(result.synthesis.startsWith("⚠ Synthesis timed out")).toBe(true);
    expect(result.synthesis).toContain("Critic: deadlock risk.");
    expect(result.synthesis).toContain("Coder: use locks.");
    // Critic before coder (review weight 1.5 vs 0.8).
    const criticPos = result.synthesis.indexOf("Critic:");
    const coderPos = result.synthesis.indexOf("Coder:");
    expect(criticPos).toBeGreaterThan(0);
    expect(criticPos).toBeLessThan(coderPos);
    // Race must resolve at synthesis timeout, not at the 1000ms hang.
    expect(elapsed).toBeLessThan(600);
  });
});
