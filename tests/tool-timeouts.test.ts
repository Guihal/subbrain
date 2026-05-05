import { describe, expect, test } from "bun:test";
import { toolTimeoutMs } from "../src/pipeline/agent-loop/tool-runner";

describe("toolTimeoutMs", () => {
  test("critic_* uses 300s by default (bumped 2026-05-03)", () => {
    expect(toolTimeoutMs("critic_review")).toBe(300_000);
  });

  test("consult_* raised to 600s (10 min ceiling)", () => {
    // 600s ceiling: N specialists (60-90s each, parallel) + teamlead synthesis
    // (60-120s) + slack. Pre-2026-05-03 was 180s — outer abort cascaded.
    expect(toolTimeoutMs("consult_coder")).toBe(600_000);
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
