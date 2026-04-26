/**
 * MEM-6: pure validators for the post-processing hippocampus writers.
 *
 * Three guards live here:
 *   - closed-taxonomy whitelist for memory_write categories (per layer);
 *   - blacklist of category prefixes + content regex patterns that never
 *     belong in long-term memory (deploy events, commit hashes, autonomous
 *     status echoes, "claude code cli" headers);
 *   - hard length cap on `content` (prevents whole article texts from
 *     landing in shared/context).
 *
 * Code-level enforcement is the system of record — the prompt also lists
 * these as hints, but we never trust the model to self-police.
 */

// Closed taxonomy. Anything outside the whitelist is rejected.
// Lower-case, kebab-friendly. Compared case-insensitively.
export const WHITELIST_SHARED = new Set<string>([
  "profile",
  "preference",
  "goal",
  "relationship",
  "skill",
  "constraint",
  "style",
]);

export const WHITELIST_CONTEXT = new Set<string>([
  "project",
  "decision",
  "bug",
  "architecture",
  "learning",
]);

// Substring (lower-case) prefix-matched against `category` — anything
// matching is blocked outright. These categories were the dominant garbage
// classes in the 2026-04-26 prod audit (deploy/commit/scout events).
export const BLACKLIST_CATEGORY_PREFIXES = [
  "deploy",
  "commit",
  "task-status",
  "task_status",
  "current-mode",
  "current_mode",
  "digest",
  "autonomous-task",
  "autonomous_task",
  "milestone",
  "scout",
  "freelance-scout",
];

// Regex patterns matched against `content`. Anything matching is blocked
// with a "blacklisted content pattern" reason — shape is intentionally
// narrow (commit hashes, deploy phrasing, CLI headers) to avoid eating
// legit facts.
export const BLACKLIST_CONTENT_REGEXES: RegExp[] = [
  /\bcommit\s+[a-f0-9]{7,40}\b/i,
  /\bdeploy(?:ed)?\s+to\s+prod/i,
  /^\[from claude code cli\]/i,
  /^claude code cli\b/i,
];

// Hard caps from the audit. shared_memory facts are short profile/preference
// statements; layer2_context entries can be richer (architecture notes,
// decisions). Whole article summaries stop being memory and start being
// documents — they need their own store, not a row in a fact table.
export const MAX_SHARED_CONTENT = 600;
export const MAX_CONTEXT_CONTENT = 2000;

// Categories whose entries are time-bound by definition and MUST carry
// `expires_at` so the night cycle can mark them stale. Plans drift, urgent
// items become not-urgent, deadlines pass — without expiry these poison
// future RAG retrieval.
export const TIME_BOUND_CATEGORIES = new Set<string>([
  "plan",
  "strategy",
  "priority",
  "urgent",
  "deadline",
]);

export type ValidationResult = { ok: true } | { ok: false; reason: string };

/**
 * Validate category + content for a memory_write call. Layer-specific
 * whitelist + global blacklist + length cap.
 */
export function validateCategoryAndContent(
  layer: "shared" | "context",
  category: string,
  content: string,
): ValidationResult {
  const cat = category.trim().toLowerCase();
  if (!cat) return { ok: false, reason: "empty category" };

  // Whitelist check (layer-specific).
  const allowed = layer === "shared" ? WHITELIST_SHARED : WHITELIST_CONTEXT;
  if (!allowed.has(cat)) {
    return {
      ok: false,
      reason: `category '${category}' not in ${layer} whitelist (${[...allowed].join(",")})`,
    };
  }

  // Category prefix blacklist (defence in depth — whitelist is exhaustive
  // but the constants drift apart over time).
  for (const bad of BLACKLIST_CATEGORY_PREFIXES) {
    if (cat.startsWith(bad)) {
      return {
        ok: false,
        reason: `category '${category}' starts with blacklisted prefix '${bad}'`,
      };
    }
  }

  // Content body checks.
  if (!content || !content.trim()) return { ok: false, reason: "empty content" };
  const cap = layer === "shared" ? MAX_SHARED_CONTENT : MAX_CONTEXT_CONTENT;
  if (content.length > cap) {
    return {
      ok: false,
      reason: `content too long (${content.length} > ${cap}); summarise or use layer3_archive`,
    };
  }
  for (const re of BLACKLIST_CONTENT_REGEXES) {
    if (re.test(content)) {
      return {
        ok: false,
        reason: `content matches blacklisted pattern (${re.source})`,
      };
    }
  }
  return { ok: true };
}

/**
 * Validate `expires_at` from a memory_write call.
 *  - undefined / null is OK unless category is time-bound.
 *  - if present: must be integer, > now+60 (at least a minute in the future),
 *    < 1e12 (sanity: anything bigger is almost certainly milliseconds).
 *  - time-bound category without expires_at → reject.
 */
export function validateExpiresAt(
  category: string,
  expiresAt: number | null | undefined,
  nowSec: number = Math.floor(Date.now() / 1000),
): ValidationResult {
  const cat = category.trim().toLowerCase();
  const hasValue = typeof expiresAt === "number" && Number.isFinite(expiresAt);
  if (TIME_BOUND_CATEGORIES.has(cat) && !hasValue) {
    return {
      ok: false,
      reason: `expires_at required for category '${category}' (unix seconds; e.g. Math.floor(Date.now()/1000) + 30*86400 for +30d)`,
    };
  }
  if (!hasValue) return { ok: true };
  const v = expiresAt as number;
  if (!Number.isInteger(v)) {
    return { ok: false, reason: `expires_at must be integer unix seconds, got ${v}` };
  }
  if (v >= 1e12) {
    // 1e12 unix seconds ≈ year 33658 — anything bigger is almost certainly
    // a millisecond timestamp passed by mistake. Convention: unix seconds
    // throughout the codebase (matches SQLite's `unixepoch()`).
    return {
      ok: false,
      reason: `expires_at must be unix seconds (Math.floor(Date.now()/1000)+...), not ms; got ${v}`,
    };
  }
  if (v <= nowSec + 60) {
    return { ok: false, reason: `expires_at must be > now+60s (now=${nowSec}, got ${v})` };
  }
  return { ok: true };
}
