/**
 * MEM-6: pure validators for hippocampus writers.
 * Whitelist + blacklist + length cap + expires_at unit policy.
 */
import { describe, expect, test } from "bun:test";
import {
  MAX_CONTEXT_CONTENT,
  MAX_SHARED_CONTENT,
  TIME_BOUND_CATEGORIES,
  validateCategoryAndContent,
  validateExpiresAt,
  WHITELIST_CONTEXT,
  WHITELIST_SHARED,
} from "../src/pipeline/agent-pipeline/post/validators";

describe("validators.validateCategoryAndContent", () => {
  test("shared whitelist accepts each whitelisted category", () => {
    for (const cat of WHITELIST_SHARED) {
      const r = validateCategoryAndContent("shared", cat, "ok content");
      expect(r.ok).toBe(true);
    }
  });

  test("context whitelist accepts each whitelisted category", () => {
    for (const cat of WHITELIST_CONTEXT) {
      const r = validateCategoryAndContent("context", cat, "ok content");
      expect(r.ok).toBe(true);
    }
  });

  test("rejects non-whitelisted shared category", () => {
    const r = validateCategoryAndContent("shared", "deploy", "freelance scout deployed");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not in shared whitelist/);
  });

  test("rejects non-whitelisted context category (e.g. 'finding' is not in context list)", () => {
    const r = validateCategoryAndContent("context", "finding", "old fact");
    expect(r.ok).toBe(false);
  });

  test("rejects blacklisted prefix even if it would somehow pass whitelist", () => {
    // 'deploy' would already fail whitelist, but the explicit prefix check
    // gives a clearer error message and survives whitelist drift.
    const r = validateCategoryAndContent("shared", "deploy-event", "anything");
    expect(r.ok).toBe(false);
  });

  test("rejects content with commit hash regex", () => {
    const r = validateCategoryAndContent("context", "decision", "merged commit a41667c closes B-1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/blacklisted pattern/);
  });

  test("rejects content with deploy phrasing", () => {
    const r = validateCategoryAndContent("context", "decision", "freelance scout deployed to prod");
    expect(r.ok).toBe(false);
  });

  test("rejects content starting with [from Claude Code CLI]", () => {
    const r = validateCategoryAndContent(
      "shared",
      "preference",
      "[from Claude Code CLI] something",
    );
    expect(r.ok).toBe(false);
  });

  test("rejects empty content", () => {
    const r = validateCategoryAndContent("shared", "preference", "   ");
    expect(r.ok).toBe(false);
  });

  test("rejects content over shared cap (600)", () => {
    const big = "x".repeat(MAX_SHARED_CONTENT + 1);
    const r = validateCategoryAndContent("shared", "preference", big);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/too long/);
  });

  test("accepts content right at shared cap", () => {
    const exact = "x".repeat(MAX_SHARED_CONTENT);
    const r = validateCategoryAndContent("shared", "preference", exact);
    expect(r.ok).toBe(true);
  });

  test("rejects content over context cap (2000)", () => {
    const big = "x".repeat(MAX_CONTEXT_CONTENT + 1);
    const r = validateCategoryAndContent("context", "decision", big);
    expect(r.ok).toBe(false);
  });

  test("case-insensitive on category", () => {
    const r = validateCategoryAndContent("shared", "Preference", "ok content");
    expect(r.ok).toBe(true);
  });
});

describe("validators.validateExpiresAt", () => {
  const NOW = 1_700_000_000;

  test("non-time-bound category without expires_at → ok", () => {
    expect(validateExpiresAt("preference", undefined, NOW).ok).toBe(true);
    expect(validateExpiresAt("preference", null, NOW).ok).toBe(true);
  });

  test("time-bound categories require expires_at", () => {
    for (const cat of TIME_BOUND_CATEGORIES) {
      const r = validateExpiresAt(cat, undefined, NOW);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/expires_at required/);
    }
  });

  test("rejects expires_at <= now+60", () => {
    const r = validateExpiresAt("plan", NOW + 30, NOW);
    expect(r.ok).toBe(false);
  });

  test("rejects expires_at as milliseconds (>= 1e12)", () => {
    const r = validateExpiresAt("plan", NOW * 1000, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/unix seconds.*not ms/i);
  });

  test("rejects non-integer expires_at", () => {
    const r = validateExpiresAt("plan", NOW + 100.5, NOW);
    expect(r.ok).toBe(false);
  });

  test("accepts valid future expires_at", () => {
    const r = validateExpiresAt("plan", NOW + 30 * 86400, NOW);
    expect(r.ok).toBe(true);
  });
});
