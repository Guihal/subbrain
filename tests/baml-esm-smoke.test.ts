import { describe, expect, test } from "bun:test";

describe("BAML ESM client", () => {
  test("generated client is importable", async () => {
    const b = await import("@subbrain/agent/baml_client");
    expect(b).toBeDefined();
  });
});
