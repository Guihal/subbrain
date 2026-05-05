/**
 * PR-A validators index. Re-exports all constants + functions so callers
 * import from this single entry point.
 *
 * M-07: categoryToKind lives here (shared_memory kind mapping).
 */
import type { MemoryKind } from "../../../../db";

export type { MemoryKind } from "../../../../db";
export * from "./dedup-modes";
export * from "./whitelist";

import {
  BLACKLIST_CATEGORY_PREFIXES,
  BLACKLIST_CONTENT_REGEXES,
  MAX_CONTEXT_CONTENT,
  MAX_SHARED_CONTENT,
  TIME_BOUND_CATEGORIES,
  WHITELIST_CONTEXT,
  WHITELIST_SHARED,
} from "./whitelist";

export type ValidationResult = { ok: true } | { ok: false; reason: string };

export function validateCategoryAndContent(
  layer: "shared" | "context",
  category: string,
  content: string,
): ValidationResult {
  const cat = category.trim().toLowerCase();
  if (!cat) return { ok: false, reason: "empty category" };
  const allowed = layer === "shared" ? WHITELIST_SHARED : WHITELIST_CONTEXT;
  if (!allowed.has(cat))
    return {
      ok: false,
      reason: `category '${category}' not in ${layer} whitelist (${[...allowed].join(",")})`,
    };
  for (const bad of BLACKLIST_CATEGORY_PREFIXES)
    if (cat.startsWith(bad))
      return {
        ok: false,
        reason: `category '${category}' starts with blacklisted prefix '${bad}'`,
      };
  if (!content?.trim()) return { ok: false, reason: "empty content" };
  const cap = layer === "shared" ? MAX_SHARED_CONTENT : MAX_CONTEXT_CONTENT;
  if (content.length > cap)
    return {
      ok: false,
      reason: `content too long (${content.length} > ${cap}); summarise or use layer3_archive`,
    };
  for (const re of BLACKLIST_CONTENT_REGEXES)
    if (re.test(content))
      return { ok: false, reason: `content matches blacklisted pattern (${re.source})` };
  return { ok: true };
}

export function validateExpiresAt(
  category: string,
  expiresAt: number | null | undefined,
  nowSec: number = Math.floor(Date.now() / 1000),
): ValidationResult {
  const cat = category.trim().toLowerCase();
  const hasValue = typeof expiresAt === "number" && Number.isFinite(expiresAt);
  if (TIME_BOUND_CATEGORIES.has(cat) && !hasValue)
    return {
      ok: false,
      reason: `expires_at required for category '${category}' (unix seconds; e.g. Math.floor(Date.now()/1000) + 30*86400 for +30d)`,
    };
  if (!hasValue) return { ok: true };
  const v = expiresAt as number;
  if (!Number.isInteger(v))
    return { ok: false, reason: `expires_at must be integer unix seconds, got ${v}` };
  if (v >= 1e12)
    return {
      ok: false,
      reason: `expires_at must be unix seconds (Math.floor(Date.now()/1000)+...), not ms; got ${v}`,
    };
  if (v <= nowSec + 60)
    return { ok: false, reason: `expires_at must be > now+60s (now=${nowSec}, got ${v})` };
  return { ok: true };
}

const PERSONA_CATEGORIES = new Set<string>(["profile", "preference", "relationship"]);

export function categoryToKind(category: string, layer: "shared" | "context"): MemoryKind {
  if (layer !== "shared") return "semantic";
  if (PERSONA_CATEGORIES.has(category.trim().toLowerCase())) return "persona";
  return "semantic";
}
