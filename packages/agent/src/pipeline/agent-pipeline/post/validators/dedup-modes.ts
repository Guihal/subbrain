/**
 * PR-A: per-category dedup mode + differential TTL defaults.
 *
 * strict   — cosine ≥ 0.92 → reject (stable facts).
 * supersede — cosine ≥ 0.95 → reject; 0.85-0.95 → supersede; <0.85 → fresh.
 */

export type DedupMode = "strict" | "supersede";

export const MEMORY_DEDUP_MODE_BY_CATEGORY: Record<string, DedupMode> = {
  // shared — stable (strict)
  profile: "strict",
  skill: "strict",
  architecture: "strict",
  // shared — dynamic (supersede)
  preference: "supersede",
  goal: "supersede",
  relationship: "supersede",
  style: "supersede",
  constraint: "supersede",
  // context — supersede
  decision: "supersede",
  learning: "supersede",
  project: "supersede",
  bug: "supersede",
};

const D = 86400;

/**
 * Default expires_at (unix seconds) when agent omits it.
 * Returns null → immortal.
 */
export function defaultExpiresAt(
  layer: "shared" | "context",
  category: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): number | null {
  const cat = category.trim().toLowerCase();
  if (layer === "shared") {
    if (["profile", "preference", "skill"].includes(cat)) return null;
    if (["goal", "relationship", "constraint", "style"].includes(cat)) return nowSec + 180 * D;
  }
  if (layer === "context") {
    if (["decision", "architecture", "learning"].includes(cat)) return nowSec + 90 * D;
    if (["project", "bug"].includes(cat)) return nowSec + 30 * D;
  }
  return null;
}
