import { describe, expect, test } from "bun:test";
import {
  fromLegacy,
  type ToolResult,
  type ToolResultV2,
  toLegacy,
} from "../packages/agent/src/mcp/types";

describe("toLegacy", () => {
  test("success → { success: true, data }", () => {
    const v2: ToolResultV2 = { kind: "success", data: 42 };
    expect(toLegacy(v2)).toEqual({ success: true, data: 42 });
  });

  test("error → { success: false, error }", () => {
    const v2: ToolResultV2 = {
      kind: "error",
      error: { code: "E1", message: "m1" },
    };
    expect(toLegacy(v2)).toEqual({
      success: false,
      error: { code: "E1", message: "m1" },
    });
  });

  test("timeout → { success: false, error }", () => {
    const v2: ToolResultV2 = {
      kind: "timeout",
      error: { code: "timeout", message: "took too long" },
    };
    expect(toLegacy(v2)).toEqual({
      success: false,
      error: { code: "timeout", message: "took too long" },
    });
  });

  test("rejected → { success: false, error }", () => {
    const v2: ToolResultV2 = {
      kind: "rejected",
      error: { code: "R1", message: "rejected" },
    };
    expect(toLegacy(v2)).toEqual({
      success: false,
      error: { code: "R1", message: "rejected" },
    });
  });

  test("denied → { success: false, error }", () => {
    const v2: ToolResultV2 = {
      kind: "denied",
      error: { code: "D1", message: "denied" },
    };
    expect(toLegacy(v2)).toEqual({
      success: false,
      error: { code: "D1", message: "denied" },
    });
  });
});

describe("fromLegacy", () => {
  test("{ success: true } → success", () => {
    const legacy: ToolResult = { success: true, data: { x: 1 } };
    expect(fromLegacy(legacy)).toEqual({
      kind: "success",
      data: { x: 1 },
    });
  });

  test("{ success: false, error: object } → error", () => {
    const legacy: ToolResult = {
      success: false,
      error: { code: "E2", message: "m2" },
    };
    expect(fromLegacy(legacy)).toEqual({
      kind: "error",
      error: { code: "E2", message: "m2" },
    });
  });

  test("{ success: false, error: string } → error with code unknown", () => {
    const legacy: ToolResult = { success: false, error: "oops" };
    expect(fromLegacy(legacy)).toEqual({
      kind: "error",
      error: { code: "unknown", message: "oops" },
    });
  });

  test("{ success: false, error: undefined } → error with code unknown", () => {
    const legacy: ToolResult = { success: false };
    expect(fromLegacy(legacy)).toEqual({
      kind: "error",
      error: { code: "unknown", message: "unknown error" },
    });
  });
});

describe("roundtrip", () => {
  test("legacy → new → legacy preserves data", () => {
    const legacy: ToolResult = { success: true, data: [1, 2, 3] };
    expect(toLegacy(fromLegacy(legacy))).toEqual(legacy);
  });

  test("legacy error object roundtrips", () => {
    const legacy: ToolResult = {
      success: false,
      error: { code: "C", message: "M" },
    };
    expect(toLegacy(fromLegacy(legacy))).toEqual(legacy);
  });

  test("legacy error string does NOT roundtrip (string → object)", () => {
    const legacy: ToolResult = { success: false, error: "fail" };
    const round = toLegacy(fromLegacy(legacy));
    expect(round).toEqual({
      success: false,
      error: { code: "unknown", message: "fail" },
    });
  });
});
