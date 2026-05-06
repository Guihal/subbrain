import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { MODEL_MAP, resolveModel, getFallback } from "@subbrain/core/lib/model-map";
import { resolveNightModel } from "@subbrain/agent/pipeline/night-cycle/model";

describe("sleep virtual role", () => {
  test("exists in MODEL_MAP", () => {
    expect(MODEL_MAP.sleep).toBeDefined();
    expect(MODEL_MAP.sleep.primary).toBe("deepseek-ai/deepseek-v4-flash");
    expect(MODEL_MAP.sleep.primaryProvider).toBe("nvidia");
    expect(MODEL_MAP.sleep.fallback).toBe("MiniMax-M2.7");
    expect(MODEL_MAP.sleep.fallbackProvider).toBe("minimax");
  });

  test("resolveModel returns correct target", () => {
    const target = resolveModel("sleep");
    expect(target.model).toBe("deepseek-ai/deepseek-v4-flash");
    expect(target.provider).toBe("nvidia");
  });

  test("getFallback returns correct target", () => {
    const fb = getFallback("sleep");
    expect(fb).not.toBeNull();
    expect(fb!.model).toBe("MiniMax-M2.7");
    expect(fb!.provider).toBe("minimax");
  });
});

describe("resolveNightModel", () => {
  const original = process.env.NIGHT_CYCLE_MODEL;

  beforeEach(() => {
    delete process.env.NIGHT_CYCLE_MODEL;
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env.NIGHT_CYCLE_MODEL;
    } else {
      process.env.NIGHT_CYCLE_MODEL = original;
    }
  });

  test("returns env value when set", () => {
    process.env.NIGHT_CYCLE_MODEL = "memory";
    expect(resolveNightModel()).toBe("memory");
    process.env.NIGHT_CYCLE_MODEL = "teamlead";
    expect(resolveNightModel()).toBe("teamlead");
  });

  test('returns "sleep" when env is unset', () => {
    delete process.env.NIGHT_CYCLE_MODEL;
    expect(resolveNightModel()).toBe("sleep");
  });
});
