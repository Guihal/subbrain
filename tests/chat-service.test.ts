/**
 * ChatService unit tests (PR 26a — LAYER-3 services split).
 *
 * Pure unit coverage on mocked deps: no HTTP, no real router, no pipeline.
 * Asserts the direct-vs-pipeline decision, stream vs sync shape, and that
 * `extractChatMeta` reads the same headers the pre-refactor route did. HTTP
 * integration (routes/chat.ts wiring) stays covered by
 * `tests/chat-direct-mode.test.ts` and `tests/chat-continuity.test.ts`.
 */
import { describe, test, expect } from "bun:test";
import { ChatService, extractChatMeta } from "../src/services/chat";
import type { ChatResponse } from "../src/providers/types";

function makeRouter(overloaded: Record<string, boolean>) {
  let directCalled = false;
  let directStreamCalled = false;
  const router = {
    isOverloadedFor: (p: string) => Boolean(overloaded[p]),
    get isOverloaded() { return Boolean(overloaded.nvidia); },
    chat: async (_model: string, _params: unknown): Promise<ChatResponse> => {
      directCalled = true;
      return {
        id: "r", object: "chat.completion", created: 0, model: "stub",
        choices: [{
          index: 0, finish_reason: "stop",
          message: { role: "assistant", content: "direct-reply" },
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
    },
    chatStream: async (): Promise<ReadableStream<Uint8Array>> => {
      directStreamCalled = true;
      return new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode("data: {}\n\n"));
          c.close();
        },
      });
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { router, check: () => ({ directCalled, directStreamCalled }) };
}

function makePipeline() {
  let pipelineCalled = false;
  let lastReq: unknown = null;
  const pipeline = {
    execute: async (req: unknown) => {
      pipelineCalled = true;
      lastReq = req;
      return {
        response: {
          id: "p", object: "chat.completion", created: 0, model: "stub",
          choices: [{
            index: 0, finish_reason: "stop",
            message: { role: "assistant", content: "pipeline-reply" },
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        } as ChatResponse,
        requestId: "req-1",
        sessionId: "sess-1",
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { pipeline, check: () => ({ pipelineCalled, lastReq }) };
}

describe("extractChatMeta", () => {
  test("reads X-Chat-Id / source / session / direct-mode / agent-id", () => {
    const meta = extractChatMeta({
      "x-chat-id": "c1",
      "x-chat-source": "tg",
      "x-session-id": "s1",
      "x-direct-mode": "true",
      "x-agent-id": "alice",
    });
    expect(meta).toEqual({
      chatId: "c1",
      source: "tg",
      sessionId: "s1",
      directModeForced: true,
      agentId: "alice",
    });
  });
  test("agentId defaults to null when header absent", () => {
    expect(extractChatMeta({}).agentId).toBeNull();
  });
  test("defaults source to api when absent", () => {
    expect(extractChatMeta({}).source).toBe("api");
  });
  test("direct-mode only forced on literal 'true'", () => {
    expect(extractChatMeta({ "x-direct-mode": "1" }).directModeForced).toBe(false);
    expect(extractChatMeta({ "x-direct-mode": "true" }).directModeForced).toBe(true);
  });
});

describe("ChatService.handle — direct vs pipeline", () => {
  test("non-overloaded + virtual role → pipeline.execute", async () => {
    const { router } = makeRouter({ nvidia: false, minimax: false });
    const { pipeline, check } = makePipeline();
    const svc = new ChatService(router, pipeline, undefined);
    const res = await svc.handle(
      { model: "teamlead", messages: [{ role: "user", content: "hi" }] },
      { source: "api", directModeForced: false },
    );
    expect(res.status).toBe(200);
    expect(check().pipelineCalled).toBe(true);
    const body = await res.json();
    expect(body.choices[0].message.content).toBe("pipeline-reply");
  });

  test("directModeForced → router.chat, pipeline untouched", async () => {
    const { router, check: rc } = makeRouter({ nvidia: false, minimax: false });
    const { pipeline, check: pc } = makePipeline();
    const svc = new ChatService(router, pipeline, undefined);
    const res = await svc.handle(
      { model: "teamlead", messages: [{ role: "user", content: "hi" }] },
      { source: "api", directModeForced: true },
    );
    expect(res.status).toBe(200);
    expect(pc().pipelineCalled).toBe(false);
    expect(rc().directCalled).toBe(true);
    const body = await res.json();
    expect(body.choices[0].message.content).toBe("direct-reply");
  });

  test("target provider overloaded → direct (PR 23: per-provider)", async () => {
    // teamlead resolves to minimax; mark minimax overloaded → direct.
    const { router, check: rc } = makeRouter({ nvidia: false, minimax: true });
    const { pipeline, check: pc } = makePipeline();
    const svc = new ChatService(router, pipeline, undefined);
    await svc.handle(
      { model: "teamlead", messages: [{ role: "user", content: "hi" }] },
      { source: "api", directModeForced: false },
    );
    expect(pc().pipelineCalled).toBe(false);
    expect(rc().directCalled).toBe(true);
  });

  test("NVIDIA overload does not drag teamlead (minimax) into direct", async () => {
    const { router, check: rc } = makeRouter({ nvidia: true, minimax: false });
    const { pipeline, check: pc } = makePipeline();
    const svc = new ChatService(router, pipeline, undefined);
    await svc.handle(
      { model: "teamlead", messages: [{ role: "user", content: "hi" }] },
      { source: "api", directModeForced: false },
    );
    expect(pc().pipelineCalled).toBe(true);
    expect(rc().directCalled).toBe(false);
  });

  test("streaming direct path → SSE content-type", async () => {
    const { router } = makeRouter({ nvidia: false, minimax: false });
    const svc = new ChatService(router, undefined, undefined);
    const res = await svc.handle(
      { model: "teamlead", messages: [{ role: "user", content: "hi" }], stream: true },
      { source: "api", directModeForced: true },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    // Drain so the mock stream completes.
    const reader = res.body!.getReader();
    while (!(await reader.read()).done) { /* drain */ }
  });
});
