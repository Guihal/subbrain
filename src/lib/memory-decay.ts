// M-08: MemoryBank-style forgetting curve in RAG retrieval ranking.
// Pure functions only — no DB / IO / logger / globals. Easy to unit-test.
//
// Reference: MemoryBank (AAAI '24, arXiv 2305.10250). Each memo has a recall
// score `R = exp(-Δt / S)` where `S` (memory strength) grows with the row's
// access_count + salience. Stacks multiplicatively with persona (M-07) and
// salience (M-03) boosts already in `rag/pipeline.ts`. **Ranking signal only
// — never used to delete rows.**
//
// `tau` characteristic-decay-time intuition:
//   access_count=0,  salience=0.5 → tau ≈ 1 day  → R(1d)≈0.37, R(7d)≈0.001
//   access_count=10, salience=1.0 → tau ≈ 4.6 d  → R(7d)≈0.22

import type { RAGResult } from "../rag/types";

const SECONDS_PER_DAY = 86400;

/**
 * MemoryBank recall score `R = exp(-Δt / S)` in [0, 1].
 *
 * - `lastAccessSeconds === null` → 1.0 (never accessed; treat as fresh proxy,
 *   not as a penalty — pre-M-02 rows would otherwise be unfairly nuked).
 * - `Δt = 0` → 1.0.
 * - Higher `accessCount` + higher `salience` → larger `tau` → slower decay.
 *
 * Pure: deterministic in inputs, no `Date.now()` here — caller passes `now`.
 */
export function computeRecallScore(
  nowSeconds: number,
  lastAccessSeconds: number | null,
  accessCount: number,
  salience: number,
): number {
  if (lastAccessSeconds === null) return 1.0;
  const dt = Math.max(0, nowSeconds - lastAccessSeconds);
  const baseStrengthDays = 1 + Math.log(1 + Math.max(0, accessCount));
  const salienceFactor = 0.5 + Math.max(0, Math.min(1, salience));
  const tauSeconds = baseStrengthDays * salienceFactor * SECONDS_PER_DAY;
  if (tauSeconds <= 0) return 0;
  return Math.exp(-dt / tauSeconds);
}

/**
 * Apply forgetting-curve recall multiplier to each row's `score`. Order-of-ops
 * in `RAGPipeline.search`: persona boost (M-07) → salience boost (M-03) → this.
 * Caller re-sorts after.
 *
 * `weights.recall === 0` disables the effect (multiplier collapses to 1.0).
 *
 * Persona override: `kind === 'persona'` shared rows are pinned to R=1.0
 * when `skipPersona` (default `true`) — identity facts must never decay.
 * They still receive the `(1 + W_RECALL * 1)` bump so the M-07 persona
 * boost (×1.1 upstream) keeps persona ranked above an equally-fresh
 * semantic row instead of being passed over while the semantic row
 * collects the recall bump for free.
 */
export function applyForgettingCurve(
  rows: RAGResult[],
  nowSeconds: number,
  weights: { recall: number; salience?: number },
  options?: { skipPersona?: boolean },
): RAGResult[] {
  const skipPersona = options?.skipPersona ?? true;
  return rows.map((r) => {
    const isPersona =
      skipPersona && r.layer === "shared" && r.kind === "persona";
    const recall = isPersona
      ? 1.0
      : computeRecallScore(
          nowSeconds,
          r.last_accessed_at ?? null,
          r.access_count ?? 0,
          r.salience ?? 0.5,
        );
    return { ...r, score: (r.score ?? 0) * (1 + weights.recall * recall) };
  });
}
