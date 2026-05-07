/**
 * ArbitrationRoom — specialist-level timeout/error fallback paths.
 *
 * Covers: single-valid-response shortcut (skip synthesis), all-timeout
 * "No responses received." fallback, one-throws → N-1 synthesis. Mock
 * router only; no network.
 *
 * Split out of legacy `arbitration.test.ts` (script-style → bun:test).
 */

import { describe, expect, test } from "bun:test";
import { ArbitrationRoom } from "@subbrain/agent/pipeline/arbitration";
import type { Message } from "@subbrain/core/types/providers";
import { makeResponse } from "./helpers/arbitration-mocks";

describe("ArbitrationRoom.run — single valid response → skip synthesis", () => {
  test("returns coder content directly when others timeout", async () => {
    const router = {
      chat: async (model: string, _params: { messages: Message[] }) => {
        if (model === "coder") return makeResponse("Only coder responded.");
        return new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), 100),
        );
      },
    } as never;
    const room = new ArbitrationRoom(router);
    const result = await room.run("Review this code", "", {
      agents: ["coder", "critic"],
      category: "review",
      timeout: 200,
    });
    expect(result.synthesis).toBe("Only coder responded.");
  });
});

describe("ArbitrationRoom.run — all timeout → fallback string", () => {
  test("synthesis becomes 'No responses received.'", async () => {
    const router = {
      chat: () =>
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 50)),
    } as never;
    const room = new ArbitrationRoom(router);
    const result = await room.run("Test", "", {
      agents: ["coder", "critic"],
      category: "code",
      timeout: 100,
    });
    expect(result.synthesis).toBe("No responses received.");
    expect(result.agentResponses.every((r) => r.timedOut || r.content === "")).toBe(true);
  });
});

describe("ArbitrationRoom.run — one specialist throws → others still synthesize", () => {
  test("Promise.allSettled keeps N-1 responses", async () => {
    let callIdx = 0;
    const router = {
      chat: async (model: string, _params: { messages: Message[] }) => {
        callIdx++;
        if (model !== "teamlead" && callIdx === 2) throw new Error("upstream 500");
        if (model === "teamlead") return makeResponse("Synth after partial fail.");
        return makeResponse(`${model} ok`);
      },
    } as never;
    const room = new ArbitrationRoom(router);
    const result = await room.run("x", "", {
      agents: ["coder", "critic", "generalist"],
      category: "architecture",
      timeout: 500,
    });
    expect(result.synthesis).toBe("Synth after partial fail.");
    expect(result.agentResponses.filter((r) => r.content.length > 0).length).toBe(2);
  });
});
