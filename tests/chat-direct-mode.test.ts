import { describe, expect, test } from "bun:test";
import type { ChatResponse } from "@subbrain/providers/types";
import { Elysia } from "elysia";
import { chatRoute } from "../src/routes/chat";

/**
 * Stub router where isOverloadedFor answers per-provider. We track whether
 * the chat route reached the direct-proxy branch or the pipeline branch by
 * spying on which sink (pipeline.execute vs router.chat) was hit.
 */
function makeStubs(overloaded: Record<string, boolean>) {
  let pipelineCalled = false;
  let directCalled = false;

  const router = {
    isOverloadedFor: (p: string) => Boolean(overloaded[p]),
    get isOverloaded() {
      return Boolean(overloaded.nvidia);
    },
    chat: async (_model: string, _params: unknown): Promise<ChatResponse> => {
      directCalled = true;
      return {
        id: "r",
        object: "chat.completion",
        created: 0,
        model: "stub",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: "direct-reply" },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
    },
    chatStream: async () => {
      throw new Error("unused");
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const pipeline = {
    execute: async (_req: unknown) => {
      pipelineCalled = true;
      return {
        response: {
          id: "p",
          object: "chat.completion",
          created: 0,
          model: "stub",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: { role: "assistant", content: "pipeline-reply" },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        } as ChatResponse,
        requestId: "req-1",
        sessionId: "sess-1",
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  return {
    router,
    pipeline,
    check: () => ({ pipelineCalled, directCalled }),
  };
}

describe("routes/chat direct-mode per-provider overload (ROUTE-1)", () => {
  test("MiniMax overloaded + model=teamlead (primary=nvidia) stays in pipeline", async () => {
    // Per-role NIM swap 2026-05-03: teamlead.primary now nvidia (k2-thinking).
    // MiniMax saturation no longer drags teamlead into direct mode.
    const { router, pipeline, check } = makeStubs({
      nvidia: false,
      minimax: true,
    });
    const app = new Elysia().use(chatRoute(router, pipeline));

    const res = await app.handle(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "teamlead",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    );
    expect(res.status).toBe(200);

    const { pipelineCalled, directCalled } = check();
    expect(pipelineCalled).toBe(true);
    expect(directCalled).toBe(false);
  });

  test("target provider overloaded → direct-mode (bypasses pipeline)", async () => {
    const { router, pipeline, check } = makeStubs({
      nvidia: true, // NVIDIA saturated — teamlead now targets nvidia (k2-thinking)
      minimax: false,
    });
    const app = new Elysia().use(chatRoute(router, pipeline));

    const res = await app.handle(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "teamlead",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    );
    expect(res.status).toBe(200);

    const { pipelineCalled, directCalled } = check();
    expect(pipelineCalled).toBe(false);
    expect(directCalled).toBe(true);
  });

  test("explicit X-Direct-Mode header forces direct regardless of overload", async () => {
    const { router, pipeline, check } = makeStubs({
      nvidia: false,
      minimax: false,
    });
    const app = new Elysia().use(chatRoute(router, pipeline));

    const res = await app.handle(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-direct-mode": "true",
        },
        body: JSON.stringify({
          model: "teamlead",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    );
    expect(res.status).toBe(200);

    const { pipelineCalled, directCalled } = check();
    expect(pipelineCalled).toBe(false);
    expect(directCalled).toBe(true);
  });
});
