// M-08: MemoryBank-style forgetting curve in RAG retrieval ranking.
// Pure functions only — no DB / IO / logger / globals. Easy to unit-test.
// Reference: MemoryBank (AAAI '24, arXiv 2305.10250). Recall score
// `R = exp(-Δt / S)` where `S` grows with access_count + salience. Stacks
// multiplicatively with persona (M-07) + salience (M-03) boosts in
// `rag/pipeline.ts`. **Ranking signal only — never used to delete rows.**
// `tau` intuition: access_count=0, salience=0.5 → tau ≈ 1 day  → R(1d)≈0.37;
//                  access_count=10, salience=1.0 → tau ≈ 4.6 d → R(7d)≈0.22.
// M-08.1: per-kind tau multiplier (episodic ×0.5, procedural ×2.0,
// semantic/undefined ×1.0). Persona handled by `skipPersona` (R=1.0 pin).

import type { RAGResult } from "@subbrain/core/types/rag";

const SECONDS_PER_DAY = 86400;

// M-08.1: env knobs read at call-time so tests can override.
const decayMultEpisodic = () => Number(process.env.RAG_DECAY_MULT_EPISODIC) || 0.5;
const decayMultProcedural = () => Number(process.env.RAG_DECAY_MULT_PROCEDURAL) || 2.0;

/**
 * MemoryBank recall score `R = exp(-Δt / S)` in [0, 1]. Pure: deterministic
 * in inputs, no `Date.now()` — caller passes `now`. `lastAccessSeconds === null`
 * or `Δt = 0` → 1.0. Higher `accessCount`/`salience` → larger `tau` → slower
 * decay. `kind` mults: episodic 0.5, procedural 2.0, else 1.0.
 */
export function computeRecallScore(
  nowSeconds: number,
  lastAccessSeconds: number | null,
  accessCount: number,
  salience: number,
  kind?: string,
): number {
  if (lastAccessSeconds === null) return 1.0;
  const dt = Math.max(0, nowSeconds - lastAccessSeconds);
  const baseStrengthDays = 1 + Math.log(1 + Math.max(0, accessCount));
  const salienceFactor = 0.5 + Math.max(0, Math.min(1, salience));
  const kindMult =
    kind === "episodic" ? decayMultEpisodic() : kind === "procedural" ? decayMultProcedural() : 1.0;
  const tauSeconds = baseStrengthDays * salienceFactor * kindMult * SECONDS_PER_DAY;
  if (tauSeconds <= 0) return 0;
  return Math.exp(-dt / tauSeconds);
}

/**
 * Apply forgetting-curve recall multiplier to each row's `score`. Order-of-ops
 * in `RAGPipeline.search`: persona boost (M-07) → salience boost (M-03) → this.
 * Caller re-sorts after. `weights.recall === 0` disables (multiplier → 1.0).
 * Persona override: shared `kind === 'persona'` rows pinned to R=1.0 when
 * `skipPersona` (default `true`) — identity facts must never decay. They still
 * get the `(1 + W_RECALL * 1)` bump so M-07 persona boost (×1.1 upstream)
 * keeps them above equally-fresh semantic rows on identical-content queries.
 */
export function applyForgettingCurve(
  rows: RAGResult[],
  nowSeconds: number,
  weights: { recall: number; salience?: number },
  options?: { skipPersona?: boolean },
): RAGResult[] {
  const skipPersona = options?.skipPersona ?? true;
  return rows.map((r) => {
    const isPersona = skipPersona && r.layer === "shared" && r.kind === "persona";
    const recall = isPersona
      ? 1.0
      : computeRecallScore(
          nowSeconds,
          r.last_accessed_at ?? null,
          r.access_count ?? 0,
          r.salience ?? 0.5,
          r.kind,
        );
    return { ...r, score: (r.score ?? 0) * (1 + weights.recall * recall) };
  });
}
