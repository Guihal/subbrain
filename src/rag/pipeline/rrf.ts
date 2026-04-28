import { RRF_K, type RAGResult } from "../types";

export function dedupeById(results: RAGResult[]): RAGResult[] {
  // M-04: dedupe key is `${layer}:${id}` — log layer ids are stringified
  // integers ("42") while shared/context/archive use uuids; an unguarded
  // id-only key would silently drop one if a future layer emitted numeric
  // ids that happened to collide with an existing uuid prefix.
  const seen = new Map<string, RAGResult>();
  for (const r of results) {
    const key = `${r.layer}:${r.id}`;
    if (!seen.has(key)) seen.set(key, r);
  }
  return [...seen.values()];
}

/**
 * Recency boost factor: newer entries get slightly higher scores.
 * Returns 1.0..1.5 — a 50% max boost for very recent entries. Pure —
 * `updated_at` must be populated by the caller (FTS/vec SELECTs already
 * return it, no extra DB round-trips here).
 */
function getRecencyBoost(updatedAt: number | undefined, nowSec: number): number {
  if (!updatedAt) return 1.0;
  const ageHours = (nowSec - updatedAt) / 3600;
  // Decay: 1.5 for < 1h, 1.3 for < 24h, 1.1 for < 7d, 1.0 for older.
  if (ageHours < 1) return 1.5;
  if (ageHours < 24) return 1.3;
  if (ageHours < 168) return 1.1;
  return 1.0;
}

export function rrfMerge(ftsResults: RAGResult[], vecResults: RAGResult[]): RAGResult[] {
  const scores = new Map<string, { result: RAGResult; score: number }>();

  // Score FTS results by rank position.
  for (let i = 0; i < ftsResults.length; i++) {
    const r = ftsResults[i];
    const rrfScore = 1 / (RRF_K + i + 1);
    const existing = scores.get(r.id);
    if (existing) existing.score += rrfScore;
    else scores.set(r.id, { result: r, score: rrfScore });
  }

  // Score vector results by rank position.
  for (let i = 0; i < vecResults.length; i++) {
    const r = vecResults[i];
    const rrfScore = 1 / (RRF_K + i + 1);
    const existing = scores.get(r.id);
    if (existing) {
      existing.score += rrfScore;
      // Keep the richer snippet.
      if (r.snippet.length > existing.result.snippet.length) {
        existing.result.snippet = r.snippet;
      }
    } else {
      scores.set(r.id, { result: r, score: rrfScore });
    }
  }

  // Apply recency boost: entries from context/archive with timestamps.
  const now = Date.now() / 1000; // unix seconds
  for (const entry of scores.values()) {
    const recency = getRecencyBoost(entry.result.updated_at, now);
    entry.score *= recency;
  }

  // Sort by combined RRF score * recency.
  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .map(({ result, score }) => ({ ...result, score }));
}
