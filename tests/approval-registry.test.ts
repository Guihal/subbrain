/**
 * 8a-2: approval registry + operator resolver tests.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  canonicalizeArgs,
  GATED_TOOLS,
  requiresApproval,
  resolveOperatorChat,
} from "@subbrain/agent/mcp/registry/approval-registry";

describe("approval-registry (8a-2)", () => {
  const savedEnv = {
    APPROVAL_DISABLE: process.env.APPROVAL_DISABLE,
    APPROVAL_OPERATOR_CHAT_ID: process.env.APPROVAL_OPERATOR_CHAT_ID,
    TG_OWNER_CHAT_ID: process.env.TG_OWNER_CHAT_ID,
  };

  beforeEach(() => {
    delete process.env.APPROVAL_DISABLE;
    delete process.env.APPROVAL_OPERATOR_CHAT_ID;
    delete process.env.TG_OWNER_CHAT_ID;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
      else (process.env as Record<string, string | undefined>)[k] = v;
    }
  });

  test("GATED_TOOLS contains tg_send_message and tg_send_report in both modes", () => {
    const names = GATED_TOOLS.map((g) => g.tool);
    expect(names).toContain("tg_send_message");
    expect(names).toContain("tg_send_report");
    for (const entry of GATED_TOOLS) {
      expect(entry.modes).toContain("scheduled");
      expect(entry.modes).toContain("interactive");
    }
  });

  test("requiresApproval returns true for gated tools in scheduled mode", () => {
    expect(requiresApproval("tg_send_message", "scheduled")).toBe(true);
    expect(requiresApproval("tg_send_report", "scheduled")).toBe(true);
  });

  test("requiresApproval returns true for gated tools in interactive mode", () => {
    expect(requiresApproval("tg_send_message", "interactive")).toBe(true);
    expect(requiresApproval("tg_send_report", "interactive")).toBe(true);
  });

  test("requiresApproval treats undefined agentMode as interactive", () => {
    expect(requiresApproval("tg_send_message", undefined)).toBe(true);
    expect(requiresApproval("tg_send_report", undefined)).toBe(true);
  });

  test("requiresApproval returns false for non-gated tools", () => {
    expect(requiresApproval("think", "interactive")).toBe(false);
    expect(requiresApproval("think", "scheduled")).toBe(false);
    expect(requiresApproval("memory_search", "interactive")).toBe(false);
  });

  test("requiresApproval returns false for unknown tools", () => {
    expect(requiresApproval("unknown_tool", "interactive")).toBe(false);
    expect(requiresApproval("unknown_tool", "scheduled")).toBe(false);
  });

  test("APPROVAL_DISABLE=true bypasses all gates", () => {
    process.env.APPROVAL_DISABLE = "true";
    expect(requiresApproval("tg_send_message", "interactive")).toBe(false);
    expect(requiresApproval("tg_send_message", "scheduled")).toBe(false);
    expect(requiresApproval("tg_send_report", "interactive")).toBe(false);
    expect(requiresApproval("think", "interactive")).toBe(false);
  });

  test("resolveOperatorChat returns null when both env vars unset", () => {
    expect(resolveOperatorChat()).toBeNull();
  });

  test("resolveOperatorChat reads APPROVAL_OPERATOR_CHAT_ID", () => {
    process.env.APPROVAL_OPERATOR_CHAT_ID = "12345";
    expect(resolveOperatorChat()).toBe(12345);
  });

  test("resolveOperatorChat falls back to TG_OWNER_CHAT_ID", () => {
    process.env.TG_OWNER_CHAT_ID = "67890";
    expect(resolveOperatorChat()).toBe(67890);
  });

  test("resolveOperatorChat prefers APPROVAL_OPERATOR_CHAT_ID over fallback", () => {
    process.env.APPROVAL_OPERATOR_CHAT_ID = "111";
    process.env.TG_OWNER_CHAT_ID = "222";
    expect(resolveOperatorChat()).toBe(111);
  });

  test("resolveOperatorChat returns null for non-numeric values", () => {
    process.env.APPROVAL_OPERATOR_CHAT_ID = "not-a-number";
    expect(resolveOperatorChat()).toBeNull();
    delete process.env.APPROVAL_OPERATOR_CHAT_ID;
    process.env.TG_OWNER_CHAT_ID = "";
    expect(resolveOperatorChat()).toBeNull();
  });

  test("canonicalizeArgs produces stable JSON with sorted keys", () => {
    const a = canonicalizeArgs({ z: 1, a: 2, m: 3 });
    const b = canonicalizeArgs({ m: 3, a: 2, z: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"m":3,"z":1}');
  });

  test("canonicalizeArgs handles nested objects", () => {
    const input = { b: { z: 1, a: 2 }, a: 1 };
    expect(canonicalizeArgs(input)).toBe('{"a":1,"b":{"a":2,"z":1}}');
  });

  test("canonicalizeArgs handles arrays and primitives", () => {
    expect(canonicalizeArgs([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalizeArgs("hello")).toBe('"hello"');
    expect(canonicalizeArgs(42)).toBe("42");
    expect(canonicalizeArgs(null)).toBe("null");
  });
});
