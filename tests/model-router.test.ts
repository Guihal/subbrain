import { describe, test, expect } from "bun:test";
import { ModelRouter } from "../src/lib/model-router";
import { ProviderError } from "../src/providers/nvidia";
import { UpstreamExhaustedError } from "../src/lib/errors";
import type { LLMProvider } from "../src/providers/types";

function mockProvider(status: number): LLMProvider {
  const err = () => {
    throw new ProviderError(status, `mock ${status}`);
  };
  return {
    chat: async () => err(),
    chatStream: () => {
      throw new ProviderError(status, `mock ${status}`);
    },
    embed: async () => err(),
    rerank: async () => err(),
    listModels: async () => [],
  } as LLMProvider;
}

describe("ModelRouter — HIGH-4 cap", () => {
  test("primary + fallback exhausted → UpstreamExhaustedError", async () => {
    const router = new ModelRouter({
      nvidia: mockProvider(502),
      openrouter: mockProvider(502),
      minimax: mockProvider(502),
    });

    let caught: unknown;
    try {
      await router.chat("teamlead", {
        messages: [{ role: "user", content: "hi" }],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UpstreamExhaustedError);
    const err = caught as UpstreamExhaustedError;
    expect(err.code).toBe("upstream_exhausted");
    expect(err.status).toBe(502);
    expect((err.details as { lastStatus?: number })?.lastStatus).toBe(502);
  });

  test("primary 401 → throws ProviderError directly (no fallback wrap)", async () => {
    // teamlead.primary = MiniMax-M2.7 / minimax → 401. Fallback nvidia would
    // succeed but auth errors must short-circuit the chain.
    const router = new ModelRouter({
      nvidia: mockProvider(200),
      openrouter: mockProvider(200),
      minimax: mockProvider(401),
    });
    let caught: unknown;
    try {
      await router.chat("teamlead", {
        messages: [{ role: "user", content: "hi" }],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as ProviderError).status).toBe(401);
  });
});
