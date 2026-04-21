import { describe, test, expect } from "bun:test";
import { shouldRunHippocampus } from "../src/pipeline/agent-pipeline/post/gate";
import { MIN_EXTRACTION_LENGTH } from "../src/pipeline/agent-pipeline/types";

describe("post/gate.shouldRunHippocampus", () => {
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
