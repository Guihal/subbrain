import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MODEL_MAP } from "../src/lib/model-map";
import { collectRequiredProviders, createProviders } from "../src/providers";

/**
 * Tests the optional-provider loader:
 *   - unreferenced providers → not required, skip env-key check
 *   - referenced providers missing env key → fail-fast
 *
 * We snapshot the env vars we touch and restore them after each test so the
 * suite stays isolated from whatever .env the dev has locally.
 */

const ENV_KEYS = [
  "NVIDIA_BASE_URL",
  "NVIDIA_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENROUTER_BASE_URL",
  "MINIMAX_API_KEY",
  "MINIMAX_BASE_URL",
];

type EnvSnapshot = Record<string, string | undefined>;
function snapshotEnv(): EnvSnapshot {
  const snap: EnvSnapshot = {};
  for (const k of ENV_KEYS) snap[k] = process.env[k];
  return snap;
}
function restoreEnv(snap: EnvSnapshot) {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

describe("collectRequiredProviders", () => {
  test("always includes nvidia (embed/rerank)", () => {
    const set = collectRequiredProviders({});
    expect(set.has("nvidia")).toBe(true);
  });

  test("collects primary + fallback from each route", () => {
    const set = collectRequiredProviders({
      foo: {
        primary: "m1",
        primaryProvider: "minimax",
        fallback: "m2",
        fallbackProvider: "openrouter",
      },
    });
    expect(set.has("nvidia")).toBe(true);
    expect(set.has("minimax")).toBe(true);
    expect(set.has("openrouter")).toBe(true);
  });

  test("current MODEL_MAP references minimax + nvidia only", () => {
    const set = collectRequiredProviders(MODEL_MAP);
    expect(set.has("nvidia")).toBe(true);
    expect(set.has("minimax")).toBe(true);
    expect(set.has("openrouter")).toBe(false);
  });
});

describe("createProviders — optional startup", () => {
  let snap: EnvSnapshot;

  beforeEach(() => {
    snap = snapshotEnv();
    // Minimal viable env: NVIDIA + MiniMax only. OpenRouter absent.
    process.env.NVIDIA_BASE_URL = "https://nvidia.invalid";
    process.env.NVIDIA_API_KEY = "test-nvidia";
    process.env.MINIMAX_API_KEY = "test-minimax";
    delete process.env.OPENROUTER_API_KEY;
  });
  afterEach(() => restoreEnv(snap));

  test("succeeds without OPENROUTER key when MODEL_MAP doesn't reference it", async () => {
    // Current MODEL_MAP targets only minimax + nvidia. Should load cleanly.
    const providers = await createProviders();
    expect(providers.nvidia).toBeDefined();
    expect(providers.minimax).toBeDefined();
    // OpenRouter exists but is a stub that throws on call.
    expect(providers.openrouter).toBeDefined();
    await expect(providers.openrouter.chat({ model: "x", messages: [] })).rejects.toThrow(
      /not loaded/,
    );
  });

  test("fail-fast when a referenced provider is missing its env key", async () => {
    // Mutate MODEL_MAP at runtime to reference openrouter as fallback, then
    // ensure no OpenRouter env token exists. createProviders must throw.
    const originalRoute = MODEL_MAP.teamlead;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (MODEL_MAP as any).teamlead = {
      primary: "MiniMax-M2.7",
      primaryProvider: "minimax",
      fallback: "anthropic/claude-sonnet-4.6",
      fallbackProvider: "openrouter",
    };
    try {
      await expect(createProviders()).rejects.toThrow(/OPENROUTER_API_KEY/);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (MODEL_MAP as any).teamlead = originalRoute;
    }
  });

  test("fail-fast when NVIDIA env missing", async () => {
    delete process.env.NVIDIA_BASE_URL;
    await expect(createProviders()).rejects.toThrow(/NVIDIA_BASE_URL and NVIDIA_API_KEY/);
  });
});
