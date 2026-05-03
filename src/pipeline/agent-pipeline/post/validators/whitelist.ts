/**
 * MEM-6 + PR-A: closed taxonomies, blacklists, length caps.
 * Single source of truth for validator constants.
 */

// Closed taxonomy. Anything outside is rejected. Case-insensitive.
export const WHITELIST_SHARED = new Set<string>([
  "profile", "preference", "goal", "relationship", "skill", "constraint", "style",
]);

export const WHITELIST_CONTEXT = new Set<string>([
  "project", "decision", "bug", "architecture", "learning",
  // TIME_BOUND categories: time-scoped work belongs in context layer (spec §2.3).
  "plan", "strategy", "priority", "urgent", "deadline",
]);

// Substring prefix-matched against `category`. Blocked outright.
export const BLACKLIST_CATEGORY_PREFIXES = [
  "deploy", "commit", "task-status", "task_status",
  "current-mode", "current_mode", "digest",
  "autonomous-task", "autonomous_task", "milestone", "scout", "freelance-scout",
];

// Narrow patterns matched against `content`.
export const BLACKLIST_CONTENT_REGEXES: RegExp[] = [
  /\bcommit\s+[a-f0-9]{7,40}\b/i,
  /\bdeploy(?:ed)?\s+to\s+prod/i,
  /^\[from claude code cli\]/i,
  /^claude code cli\b/i,
];

// Hard content length caps.
export const MAX_SHARED_CONTENT = 600;
export const MAX_CONTEXT_CONTENT = 2000;

// TIME_BOUND: must carry expires_at (plans drift, deadlines pass).
export const TIME_BOUND_CATEGORIES = new Set<string>([
  "plan", "strategy", "priority", "urgent", "deadline",
]);
