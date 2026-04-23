import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { collectRequiredProviders, createProviders } from "../src/providers";
import { MODEL_MAP } from "../src/lib/model-map";

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
  "GITHUB_COPILOT_TOKEN",
  "GITHUB_TOKEN",
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
        fallbackProvider: "copilot",
      },
    });
    expect(set.has("nvidia")).toBe(true);
    expect(set.has("minimax")).toBe(true);
    expect(set.has("copilot")).toBe(true);
    expect(set.has("openrouter")).toBe(false);
  });

  test("current MODEL_MAP references minimax + nvidia only", () => {
    const set = collectRequiredProviders(MODEL_MAP);
    expect(set.has("nvidia")).toBe(true);
    expect(set.has("minimax")).toBe(true);
    // Current model-map does not name copilot/openrouter anywhere.
    expect(set.has("copilot")).toBe(false);
    expect(set.has("openrouter")).toBe(false);
  });
});

describe("createProviders — optional startup", () => {
  let snap: EnvSnapshot;

  beforeEach(() => {
    snap = snapshotEnv();
    // Minimal viable env: NVIDIA + MiniMax only. Copilot/OpenRouter absent.
    process.env.NVIDIA_BASE_URL = "https://nvidia.invalid";
    process.env.NVIDIA_API_KEY = "test-nvidia";
    process.env.MINIMAX_API_KEY = "test-minimax";
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.GITHUB_COPILOT_TOKEN;
    delete process.env.GITHUB_TOKEN;
  });
  afterEach(() => restoreEnv(snap));

  test("succeeds without COPILOT / OPENROUTER keys when MODEL_MAP doesn't reference them", async () => {
    // Current MODEL_MAP targets only minimax + nvidia. Should load cleanly.
    const providers = await createProviders();
    expect(providers.nvidia).toBeDefined();
    expect(providers.minimax).toBeDefined();
    // Copilot + OpenRouter exist but are stubs that throw on call.
    expect(providers.copilot).toBeDefined();
    await expect(
      providers.copilot.chat({ model: "x", messages: [] }),
    ).rejects.toThrow(/not loaded/);
    expect(providers.openrouter).toBeDefined();
    await expect(
      providers.openrouter.chat({ model: "x", messages: [] }),
    ).rejects.toThrow(/not loaded/);
  });

  test("fail-fast when a referenced provider is missing its env key", async () => {
    // Mutate MODEL_MAP at runtime to reference copilot as fallback, then
    // ensure no Copilot env token exists. createProviders must throw.
    const originalRoute = MODEL_MAP.teamlead;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (MODEL_MAP as any).teamlead = {
      primary: "MiniMax-M2.7",
      primaryProvider: "minimax",
      fallback: "claude-sonnet-4.6",
      fallbackProvider: "copilot",
    };
    try {
      await expect(createProviders()).rejects.toThrow(
        /GITHUB_COPILOT_TOKEN|GITHUB_TOKEN/,
      );
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (MODEL_MAP as any).teamlead = originalRoute;
    }
  });

  test("fail-fast when NVIDIA env missing", async () => {
    delete process.env.NVIDIA_BASE_URL;
    await expect(createProviders()).rejects.toThrow(
      /NVIDIA_BASE_URL and NVIDIA_API_KEY/,
    );
  });
});
