import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ModelRouter } from "@subbrain/core/lib/model-router";
import { BifrostProvider } from "@subbrain/providers/bifrost";
import { ProviderError } from "@subbrain/providers/nvidia";
import type { LLMProvider } from "@subbrain/providers/types";

describe("Bifrost auth / rate / upstream errors through ModelRouter", () => {
  const oldEnv = process.env.BIFROST_ENABLED;
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl = "";
  let nextStatus = 200;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = req.method === "POST" ? await req.text() : "";
        if (req.url.includes("/v1/chat/completions")) {
          return new Response(JSON.stringify({ error: "boom", body }), {
            status: nextStatus,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    baseUrl = `http://localhost:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
    process.env.BIFROST_ENABLED = oldEnv;
  });

  function makeRouter(status: number) {
    process.env.BIFROST_ENABLED = "true";
    nextStatus = status;

    let backendCalled = 0;
    const mockBackend: LLMProvider = {
      chat: () => {
        backendCalled++;
        return Promise.resolve({
          id: "1",
          object: "chat.completion",
          created: 1,
          model: "x",
          choices: [],
        });
      },
      chatStream: () => new ReadableStream(),
      embed: () =>
        Promise.resolve({
          object: "list",
          data: [],
          model: "",
          usage: { prompt_tokens: 0, total_tokens: 0 },
        }),
      rerank: () => Promise.resolve({ results: [] }),
      listModels: () => Promise.resolve([]),
    };

    const bifrost = new BifrostProvider(baseUrl, "sk-test");
    const router = new ModelRouter(
      {
        nvidia: mockBackend,
        openrouter: mockBackend,
        minimax: mockBackend,
        "openai-compat": mockBackend,
      },
      bifrost,
    );

    return { router, backendCalled: () => backendCalled };
  }

  test("401 → ProviderError, backends untouched", async () => {
    const { router, backendCalled } = makeRouter(401);
    await expect(
      router.chat("teamlead", { messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(backendCalled()).toBe(0);
  });

  test("403 → ProviderError, backends untouched", async () => {
    const { router, backendCalled } = makeRouter(403);
    await expect(
      router.chat("teamlead", { messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(backendCalled()).toBe(0);
  });

  test("429 → ProviderError, backends untouched", async () => {
    const { router, backendCalled } = makeRouter(429);
    await expect(
      router.chat("teamlead", { messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(backendCalled()).toBe(0);
  });

  test("502 → ProviderError, backends untouched", async () => {
    const { router, backendCalled } = makeRouter(502);
    await expect(
      router.chat("teamlead", { messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(backendCalled()).toBe(0);
  });
});
