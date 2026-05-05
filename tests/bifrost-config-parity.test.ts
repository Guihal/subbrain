import { describe, expect, test } from "bun:test";
import { MODEL_MAP } from "@subbrain/core/lib/model-map";

describe("Bifrost config parity", () => {
  test("all ProviderName values have a matching Bifrost provider entry", async () => {
    const config = await Bun.file("bifrost/config.json").json();
    const parityMap: Record<string, string> = {
      nvidia: "openai",
      openrouter: "openrouter",
      minimax: "minimax",
      "openai-compat": "openai-compat",
    };

    for (const [_subbrainName, bifrostKey] of Object.entries(parityMap)) {
      expect(config.providers[bifrostKey]).toBeDefined();
    }
  });

  test("every model in MODEL_MAP is listed under its primary provider", async () => {
    const config = await Bun.file("bifrost/config.json").json();
    const parityMap: Record<string, string> = {
      nvidia: "openai",
      openrouter: "openrouter",
      minimax: "minimax",
      "openai-compat": "openai-compat",
    };

    const allModels = new Set<string>();
    for (const provider of Object.values(config.providers)) {
      for (const key of provider.keys ?? []) {
        for (const m of key.models ?? []) {
          allModels.add(m);
        }
      }
    }

    for (const route of Object.values(MODEL_MAP)) {
      if (route.primaryProvider) {
        const bifrostKey = parityMap[route.primaryProvider];
        const provider = config.providers[bifrostKey];
        expect(provider).toBeDefined();
      }
      if (route.fallbackProvider) {
        const bifrostKey = parityMap[route.fallbackProvider];
        const provider = config.providers[bifrostKey];
        expect(provider).toBeDefined();
      }
    }
  });
});
