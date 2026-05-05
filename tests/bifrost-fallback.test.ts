import { describe, expect, test } from "bun:test";
import { BifrostProvider } from "@subbrain/providers/bifrost";
import type { LLMProvider } from "@subbrain/providers/types";
import { ModelRouter } from "../src/lib/model-router";

describe("Bifrost flag-on — no legacy fallback", () => {
  test("bifrost error surfaces directly; backends untouched", async () => {
    const oldEnv = process.env.BIFROST_ENABLED;
    process.env.BIFROST_ENABLED = "true";

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

    // Use a closed port to simulate connection refusal
    const bifrost = new BifrostProvider("http://127.0.0.1:1", "sk-test");
    const router = new ModelRouter(
      {
        nvidia: mockBackend,
        openrouter: mockBackend,
        minimax: mockBackend,
        "openai-compat": mockBackend,
      },
      bifrost,
    );

    await expect(
      router.chat("teamlead", { messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow();
    expect(backendCalled).toBe(0);

    process.env.BIFROST_ENABLED = oldEnv;
  });
});
