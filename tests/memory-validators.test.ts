/**
 * PR-A: unit tests for validators.ts pure functions.
 * Covers whitelist, blacklist, length cap, TIME_BOUND, expires_at,
 * MEMORY_DEDUP_MODE_BY_CATEGORY, and defaultExpiresAt.
 */
import { describe, expect, test } from "bun:test";
import {
  defaultExpiresAt,
  MEMORY_DEDUP_MODE_BY_CATEGORY,
  TIME_BOUND_CATEGORIES,
  validateCategoryAndContent,
  validateExpiresAt,
  WHITELIST_CONTEXT,
  WHITELIST_SHARED,
} from "../src/pipeline/agent-pipeline/post/validators";

const NOW = Math.floor(Date.now() / 1000);
const FUTURE = NOW + 86400 * 30;

// ─── validateCategoryAndContent ─────────────────────────────────────────────

describe("validateCategoryAndContent — shared whitelist", () => {
  for (const cat of WHITELIST_SHARED) {
    test(`${cat} passes`, () => {
      expect(validateCategoryAndContent("shared", cat, "some content")).toEqual({ ok: true });
    });
  }

  test("non-whitelist shared category fails", () => {
    const r = validateCategoryAndContent("shared", "free-agent-digest", "content");
    expect(r.ok).toBe(false);
    expect((r as any).reason).toContain("whitelist");
  });

  test("empty category fails", () => {
    const r = validateCategoryAndContent("shared", "", "content");
    expect(r.ok).toBe(false);
  });

  test("empty content fails", () => {
    const r = validateCategoryAndContent("shared", "preference", "");
    expect(r.ok).toBe(false);
  });

  test("content over MAX_SHARED_CONTENT (600) fails", () => {
    const r = validateCategoryAndContent("shared", "preference", "x".repeat(601));
    expect(r.ok).toBe(false);
    expect((r as any).reason).toContain("too long");
  });

  test("blacklist prefix blocks despite category name not in whitelist", () => {
    const r = validateCategoryAndContent("shared", "digest-extra", "content");
    expect(r.ok).toBe(false);
  });
});

describe("validateCategoryAndContent — context whitelist", () => {
  for (const cat of WHITELIST_CONTEXT) {
    test(`${cat} passes`, () => {
      expect(validateCategoryAndContent("context", cat, "some content")).toEqual({ ok: true });
    });
  }

  test("non-whitelist context category fails", () => {
    const r = validateCategoryAndContent("context", "random-thing", "content");
    expect(r.ok).toBe(false);
  });

  test("content over MAX_CONTEXT_CONTENT (2000) fails", () => {
    const r = validateCategoryAndContent("context", "project", "x".repeat(2001));
    expect(r.ok).toBe(false);
  });

  test("TIME_BOUND categories are in context whitelist (not blocked by category check)", () => {
    // plan/strategy/priority/urgent/deadline now in WHITELIST_CONTEXT.
    // Category check must pass so validateExpiresAt is the blocking validator.
    for (const cat of TIME_BOUND_CATEGORIES) {
      const r = validateCategoryAndContent("context", cat, "some content");
      expect(r.ok).toBe(true);
    }
  });

  test("plan without expires_at fails validateExpiresAt (not whitelist)", () => {
    // Whitelist check passes; expires_at check should fail.
    const catR = validateCategoryAndContent("context", "plan", "some plan content");
    expect(catR.ok).toBe(true); // passes whitelist
    const expR = validateExpiresAt("plan", undefined, NOW);
    expect(expR.ok).toBe(false);
    expect((expR as any).reason).toContain("expires_at required");
  });
});

// ─── validateExpiresAt ───────────────────────────────────────────────────────

describe("validateExpiresAt", () => {
  test("optional for non-time-bound categories", () => {
    expect(validateExpiresAt("preference", undefined, NOW)).toEqual({ ok: true });
  });

  test("required for time-bound categories (plan/strategy/priority/urgent/deadline)", () => {
    for (const cat of TIME_BOUND_CATEGORIES) {
      const r = validateExpiresAt(cat, undefined, NOW);
      expect(r.ok).toBe(false);
      expect((r as any).reason).toContain("expires_at required");
    }
  });

  test("valid future timestamp passes", () => {
    expect(validateExpiresAt("plan", FUTURE, NOW)).toEqual({ ok: true });
  });

  test("millisecond timestamp fails (>= 1e12)", () => {
    const r = validateExpiresAt("preference", Date.now(), NOW); // ms not sec
    expect(r.ok).toBe(false);
    expect((r as any).reason).toContain("unix seconds");
  });

  test("timestamp in past/near-future (< now+60) fails", () => {
    const r = validateExpiresAt("preference", NOW + 10, NOW);
    expect(r.ok).toBe(false);
  });
});

// ─── MEMORY_DEDUP_MODE_BY_CATEGORY ──────────────────────────────────────────

describe("MEMORY_DEDUP_MODE_BY_CATEGORY", () => {
  test("profile/skill/architecture → strict", () => {
    expect(MEMORY_DEDUP_MODE_BY_CATEGORY.profile).toBe("strict");
    expect(MEMORY_DEDUP_MODE_BY_CATEGORY.skill).toBe("strict");
    expect(MEMORY_DEDUP_MODE_BY_CATEGORY.architecture).toBe("strict");
  });

  test("preference/goal/relationship/style/constraint → supersede", () => {
    for (const cat of ["preference", "goal", "relationship", "style", "constraint"]) {
      expect(MEMORY_DEDUP_MODE_BY_CATEGORY[cat]).toBe("supersede");
    }
  });

  test("context categories → supersede", () => {
    for (const cat of ["decision", "learning", "project", "bug"]) {
      expect(MEMORY_DEDUP_MODE_BY_CATEGORY[cat]).toBe("supersede");
    }
  });
});

// ─── defaultExpiresAt ───────────────────────────────────────────────────────

describe("defaultExpiresAt", () => {
  const NOW_SEC = 1000000;
  const D = 86400;

  test("shared profile/preference/skill → null (immortal)", () => {
    expect(defaultExpiresAt("shared", "profile", NOW_SEC)).toBeNull();
    expect(defaultExpiresAt("shared", "preference", NOW_SEC)).toBeNull();
    expect(defaultExpiresAt("shared", "skill", NOW_SEC)).toBeNull();
  });

  test("shared goal/relationship/constraint/style → +180d", () => {
    for (const cat of ["goal", "relationship", "constraint", "style"]) {
      const exp = defaultExpiresAt("shared", cat, NOW_SEC);
      expect(exp).toBe(NOW_SEC + 180 * D);
    }
  });

  test("context decision/architecture/learning → +90d", () => {
    for (const cat of ["decision", "architecture", "learning"]) {
      const exp = defaultExpiresAt("context", cat, NOW_SEC);
      expect(exp).toBe(NOW_SEC + 90 * D);
    }
  });

  test("context project/bug → +30d", () => {
    for (const cat of ["project", "bug"]) {
      const exp = defaultExpiresAt("context", cat, NOW_SEC);
      expect(exp).toBe(NOW_SEC + 30 * D);
    }
  });

  test("unknown category → null", () => {
    expect(defaultExpiresAt("shared", "unknown-thing", NOW_SEC)).toBeNull();
    expect(defaultExpiresAt("context", "unknown-thing", NOW_SEC)).toBeNull();
  });
});
