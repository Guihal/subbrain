import { describe, test, expect } from "bun:test";
import { toolTimeoutMs } from "../src/pipeline/agent-loop/tool-runner";

describe("toolTimeoutMs", () => {
  test("critic_* uses 120s by default", () => {
    expect(toolTimeoutMs("critic_review")).toBe(120_000);
  });

  test("consult_* raised to 180s", () => {
    // 180s = 30s (specialist) + 60s (synthesis) + slack (per tool-runner.ts).
    expect(toolTimeoutMs("consult_coder")).toBe(180_000);
  });

  test("web_* keeps 15s", () => {
    expect(toolTimeoutMs("web_search")).toBe(15_000);
  });

  test("memory_* keeps 3s", () => {
    expect(toolTimeoutMs("memory_search")).toBe(3_000);
  });

  test("embed_* keeps 5s", () => {
    expect(toolTimeoutMs("embed_content")).toBe(5_000);
  });

  test("unknown tool default raised to 10s", () => {
    expect(toolTimeoutMs("foo_bar")).toBe(10_000);
  });
});
