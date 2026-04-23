import { describe, test, expect } from "bun:test";
import { ModelRouter } from "../src/lib/model-router";
import type { LLMProvider } from "../src/providers/types";

/**
 * Stub provider — never actually called in these tests. isOverloadedFor
 * only reads rate-limiter state, not the provider impl.
 */
function stub(): LLMProvider {
  const boom = () => {
    throw new Error("stub provider: not callable in overload test");
  };
  return {
    chat: async () => boom(),
    chatStream: () => boom(),
    embed: async () => boom(),
    rerank: async () => boom(),
    listModels: async () => [],
  } as LLMProvider;
}

/**
 * Force a limiter into overload by stuffing its private `timestamps` array.
 * Sliding-window: `availableSlots = maxRpm - timestamps.length` (modulo
 * pruning, which ignores entries younger than WINDOW_MS).
 */
function saturate(router: ModelRouter, provider: string, n: number) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyRouter = router as any;
  const limiter = anyRouter.backends[provider].limiter;
  const now = Date.now();
  for (let i = 0; i < n; i++) limiter.timestamps.push(now);
}

describe("ModelRouter.isOverloadedFor — per-provider overload", () => {
  test("reports overload only for the saturated provider", () => {
    const router = new ModelRouter({
      nvidia: stub(),
      openrouter: stub(),
      copilot: stub(),
      minimax: stub(),
    });

    // NVIDIA maxRpm=40, RESERVED_SLOTS=8. Fill 33 slots → availableSlots=7 → overloaded.
    saturate(router, "nvidia", 33);

    expect(router.isOverloadedFor("nvidia")).toBe(true);
    expect(router.isOverloadedFor("minimax")).toBe(false);
    expect(router.isOverloadedFor("openrouter")).toBe(false);
    expect(router.isOverloadedFor("copilot")).toBe(false);
  });

  test("deprecated isOverloaded alias delegates to NVIDIA check", () => {
    const router = new ModelRouter({
      nvidia: stub(),
      openrouter: stub(),
      copilot: stub(),
      minimax: stub(),
    });

    expect(router.isOverloaded).toBe(false);
    saturate(router, "nvidia", 33);
    expect(router.isOverloaded).toBe(true);
  });

  test("unloaded provider reports not-overloaded (falsy by absence)", () => {
    // Construct with only nvidia present — simulate optional-provider startup
    // where Copilot/OpenRouter were skipped entirely.
    const router = new ModelRouter({
      nvidia: stub(),
      // deliberate: no openrouter, copilot, minimax
    } as unknown as Record<"nvidia", LLMProvider>);

    expect(router.isOverloadedFor("nvidia")).toBe(false);
    expect(router.isOverloadedFor("openrouter")).toBe(false);
    expect(router.isOverloadedFor("copilot")).toBe(false);
    expect(router.isOverloadedFor("minimax")).toBe(false);

    saturate(router, "nvidia", 33);
    expect(router.isOverloadedFor("nvidia")).toBe(true);
    // Still false for providers that aren't loaded at all.
    expect(router.isOverloadedFor("minimax")).toBe(false);
  });
});
