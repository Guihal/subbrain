import { describe, expect, test } from "bun:test";
import { SKIP_USER_PREFIXES, shouldRunHippocampus } from "../src/pipeline/agent-pipeline/post/gate";
import { MIN_EXTRACTION_LENGTH } from "../src/pipeline/agent-pipeline/types";

describe("post/gate.shouldRunHippocampus — length gate", () => {
  test("rejects below threshold", () => {
    expect(shouldRunHippocampus(0)).toBe(false);
    expect(shouldRunHippocampus(MIN_EXTRACTION_LENGTH - 1)).toBe(false);
  });
  test("accepts at and above threshold", () => {
    expect(shouldRunHippocampus(MIN_EXTRACTION_LENGTH)).toBe(true);
    expect(shouldRunHippocampus(MIN_EXTRACTION_LENGTH + 500)).toBe(true);
  });
  test("threshold is 100", () => {
    expect(MIN_EXTRACTION_LENGTH).toBe(100);
  });
});

describe("post/gate.shouldRunHippocampus — MEM-6 self-feed skip", () => {
  // Each prefix must short-circuit the gate even when the length check
  // passes. These messages are automated echoes (subbrain-ping CLI traffic,
  // free-agent TG digests, freelance-scout alerts) — extracting facts from
  // them produced the deploy/commit/scout-status garbage discovered in the
  // 2026-04-26 prod audit.
  for (const prefix of SKIP_USER_PREFIXES) {
    test(`skips when userMessage starts with ${JSON.stringify(prefix)}`, () => {
      const userMsg = `${prefix} freelance scout deployed to prod commit a41667c`;
      expect(shouldRunHippocampus(500, userMsg)).toBe(false);
    });
    test(`skips with leading whitespace before ${JSON.stringify(prefix)}`, () => {
      const userMsg = `   \n  ${prefix} something`;
      expect(shouldRunHippocampus(500, userMsg)).toBe(false);
    });
  }

  test("golden path: normal user message passes the gate", () => {
    const userMsg = "Я хочу подумать про rust компиляторы и обсудить план обучения.";
    expect(shouldRunHippocampus(500, userMsg)).toBe(true);
  });

  test("missing userMessage → only length gate applies (back-compat)", () => {
    expect(shouldRunHippocampus(500)).toBe(true);
    expect(shouldRunHippocampus(500, undefined)).toBe(true);
    expect(shouldRunHippocampus(50)).toBe(false);
  });

  test("empty userMessage → length gate alone decides", () => {
    expect(shouldRunHippocampus(500, "")).toBe(true);
  });

  test("ping signature in middle (not prefix) → does NOT skip", () => {
    // Conservative: prefix-only match. Mid-message mention is real content.
    const userMsg = "Я обсуждал [from Claude Code CLI] — это что за маркер?";
    expect(shouldRunHippocampus(500, userMsg)).toBe(true);
  });
});
