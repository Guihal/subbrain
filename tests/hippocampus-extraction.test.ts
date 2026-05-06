import { describe, expect, test } from "bun:test";
import {
  getExtractorPrompt,
  CONFIDENCE_RULE,
} from "@subbrain/agent/pipeline/agent-pipeline/post/prompt";

describe("hippocampus extraction prompt", () => {
  test("getExtractorPrompt contains surprising / non-obvious / actionable", () => {
    const prompt = getExtractorPrompt(5);
    expect(prompt.toLowerCase()).toContain("surprising");
    expect(prompt.toLowerCase()).toContain("non-obvious");
    expect(prompt.toLowerCase()).toContain("actionable");
  });

  test("getExtractorPrompt contains budget with maxSteps", () => {
    const prompt = getExtractorPrompt(5);
    expect(prompt).toContain("budget: 5 tool calls");
  });

  test("getExtractorPrompt contains different budget for different maxSteps", () => {
    const prompt = getExtractorPrompt(7);
    expect(prompt).toContain("budget: 7 tool calls");
  });

  test("CONFIDENCE_RULE contains 0.8 threshold", () => {
    expect(CONFIDENCE_RULE).toContain("0.8");
  });

  test("prompt does not contain anti-economy phrases", () => {
    const prompt = getExtractorPrompt(5).toLowerCase();
    const anti = [
      "save token",
      "be efficient",
      "minimize tokens",
      "token budget",
      "keep it short",
    ];
    for (const phrase of anti) {
      expect(prompt).not.toContain(phrase);
    }
  });
});
