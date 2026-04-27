/**
 * CANCEL-1 / PR 20 — when one specialist's per-call timeout fires in
 * `ArbitrationRoom.run`, the matching AbortController must be aborted so the
 * underlying `router.chat` call can bail out instead of continuing to the
 * natural end.
 */
import { describe, test, expect } from "bun:test";
import { ArbitrationRoom } from "../src/pipeline/arbitration";
import type { ChatResponse, Message } from "../src/providers/types";
import type { ModelRouter } from "../src/lib/model-router";

function makeResponse(content: string): ChatResponse {
  return {
    id: "test",
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
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

interface Call {
  model: string;
  signal?: AbortSignal;
  aborted: boolean;
}

function makeRouter(): { router: ModelRouter; calls: Call[] } {
  const calls: Call[] = [];
  const router = {
    chat: async (
      model: string,
      params: { messages: Message[]; signal?: AbortSignal },
    ): Promise<ChatResponse> => {
      const call: Call = { model, signal: params.signal, aborted: false };
      calls.push(call);

      // Fast path for teamlead synthesis — return immediately.
      if (model === "teamlead") return makeResponse("synth");

      // coder = fast (50ms); others hang until aborted or 10s elapses.
      if (model === "coder") {
        await new Promise((r) => setTimeout(r, 50));
        return makeResponse("Coder quick answer.");
      }

      // Hanging specialist — polls `signal.aborted` every 25ms.
      return await new Promise<ChatResponse>((resolve, reject) => {
        const iv = setInterval(() => {
          if (params.signal?.aborted) {
            call.aborted = true;
            clearInterval(iv);
            reject(new Error("aborted"));
          }
        }, 25);
        setTimeout(() => {
          clearInterval(iv);
          resolve(makeResponse("Slow answer that nobody will see."));
        }, 10_000);
      });
    },
  } as unknown as ModelRouter;
  return { router, calls };
}

describe("ArbitrationRoom abort propagation", () => {
  test("per-specialist timeout aborts its controller; router.chat signal fires", async () => {
    const { router, calls } = makeRouter();
    const room = new ArbitrationRoom(router);

    const start = Date.now();
    const result = await room.run("какую бд выбрать?", "", {
      agents: ["coder", "critic", "generalist"],
      category: "architecture",
      timeout: 300, // 300ms per specialist
    });
    const elapsed = Date.now() - start;

    // Room resolves quickly — does not wait for the 10s hangers.
    expect(elapsed).toBeLessThan(1500);

    // coder came back, others timed out (empty).
    const responses = Object.fromEntries(
      result.agentResponses.map((r) => [r.role, r]),
    );
    expect(responses.coder?.content).toContain("Coder quick answer");
    expect(responses.critic?.content).toBe("");
    expect(responses.generalist?.content).toBe("");

    // Every non-teamlead call received a signal.
    const specialistCalls = calls.filter((c) => c.model !== "teamlead");
    expect(specialistCalls.length).toBe(3);
    for (const c of specialistCalls) {
      expect(c.signal).toBeDefined();
    }

    // After timeout the hanging specialists observed abort on their signal.
    // Give the pollers one more tick to notice.
    await new Promise((r) => setTimeout(r, 100));
    const critic = specialistCalls.find((c) => c.model === "critic");
    const generalist = specialistCalls.find((c) => c.model === "generalist");
    expect(critic?.signal?.aborted).toBe(true);
    expect(generalist?.signal?.aborted).toBe(true);
    // The in-flight handler also saw it and rejected.
    expect(critic?.aborted).toBe(true);
    expect(generalist?.aborted).toBe(true);

    // coder signal stayed clean (finished before timeout).
    const coder = specialistCalls.find((c) => c.model === "coder");
    expect(coder?.signal?.aborted).toBe(false);
  });

  test("external signal cancels all in-flight specialists", async () => {
    const { router, calls } = makeRouter();
    const room = new ArbitrationRoom(router);
    const external = new AbortController();

    setTimeout(() => external.abort(), 150);

    const result = await room.run(
      "архитектура?",
      "",
      {
        agents: ["critic", "generalist"],
        category: "architecture",
        timeout: 10_000, // long — external wins
      },
      external.signal,
    );

    expect(result.agentResponses.every((r) => r.content === "")).toBe(true);
    const specialistCalls = calls.filter((c) => c.model !== "teamlead");
    await new Promise((r) => setTimeout(r, 100));
    for (const c of specialistCalls) {
      expect(c.signal?.aborted).toBe(true);
      expect(c.aborted).toBe(true);
    }
  });
});
