import type { MemoryDB } from "@subbrain/core/db";
import { logger } from "@subbrain/core/lib/logger";
import type { RAGResult } from "../types";

const log = logger.child("rag");

// M-07 (mig 12): persona-grade shared rows get a +10% rerank score boost.
// 1.1× is intentionally moderate — anything bigger drowns out semantic
// facts that are also relevant to the query.
const PERSONA_BOOST = 1.1;

// M-03 (mig 13): salience signal blends multiplicatively with the rerank
// score. A row at salience=1.0 gets a +10% bump (1 + 0.1 * 1); salience=0.0
// gets nothing; default 0.5 gets +5%. Stacks with persona boost — combined
// max ≈ 1.21×; the cosine signal still dominates ranking.
export const SALIENCE_BOOST_FACTOR = 0.1;

// M-02 (mig 10): the three layers we know how to bump. `RAGResult.layer` is
// a free string upstream, so this filter both narrows the type and silently
// skips any future synthetic layer (e.g. a "tasks" layer M-04 might add).
type BumpLayer = "shared" | "context" | "archive";
function isBumpLayer(l: string): l is BumpLayer {
  return l === "shared" || l === "context" || l === "archive";
}

// M-02: env flag — `RAG_BUMP_ACCESS=false` disables the post-rerank access
// bump entirely. Default on. Read at call-time (not module load) so test
// suites can toggle the flag per case without spawning a subprocess.
function bumpAccessEnabled(): boolean {
  return process.env.RAG_BUMP_ACCESS !== "false";
}

/**
 * M-07 (mig 12): boost persona-grade shared rows by `PERSONA_BOOST` (1.1×).
 * Pure mutation of score + re-sort. Non-persona rows pass through unchanged.
 * Shared-only — context/archive results have `kind === undefined` and skip
 * the multiplier branch.
 *
 * Why post-rerank: Cohere reranker doesn't see our persona signal, so the
 * bump is applied AFTER its `relevance_score` lands. For skipRerank and
 * rerank-failure paths, the same step still fires and ranks persona facts
 * above semantic ones with the same RRF score.
 */
export function applyPersonaBoost(results: RAGResult[]): RAGResult[] {
  if (results.length === 0) return results;
  const boosted = results.map((r) =>
    r.layer === "shared" && r.kind === "persona" ? { ...r, score: r.score * PERSONA_BOOST } : r,
  );
  boosted.sort((a, b) => b.score - a.score);
  return boosted;
}

/**
 * M-03 (mig 13): salience-based boost. Multiplies score by
 * `1 + 0.1 * salience` so hot rows (salience → 1.0) get up to +10% on top
 * of whatever ranking they already have. Default salience for log layer
 * (no column) or pre-mig-13 rows is 0.5 — a neutral +5%. Stacks
 * multiplicatively with persona boost.
 */
export function applySalienceBoost(results: RAGResult[]): RAGResult[] {
  if (results.length === 0) return results;
  const boosted = results.map((r) => {
    const salience = r.salience ?? 0.5;
    return { ...r, score: r.score * (1 + SALIENCE_BOOST_FACTOR * salience) };
  });
  boosted.sort((a, b) => b.score - a.score);
  return boosted;
}

/**
 * M-02: schedule a non-blocking access bump for the supplied results. Groups
 * by layer (Map<layer, ids[]>), one `bumpAccess` call per layer, fan-out via
 * `Promise.allSettled`. `void` + no `await` — caller does not wait. Errors
 * are warned and dropped. Disabled when env `RAG_BUMP_ACCESS=false` is set.
 */
export function bumpAccessAsync(memory: MemoryDB, results: RAGResult[]): void {
  if (!bumpAccessEnabled()) return;
  if (results.length === 0) return;

  const byLayer = new Map<BumpLayer, string[]>();
  for (const r of results) {
    if (!isBumpLayer(r.layer)) continue;
    const arr = byLayer.get(r.layer);
    if (arr) arr.push(r.id);
    else byLayer.set(r.layer, [r.id]);
  }
  if (byLayer.size === 0) return;

  void Promise.allSettled(
    [...byLayer.entries()].map(([layer, ids]) =>
      Promise.resolve().then(() => memory.memoryRepo.bumpAccess(layer, ids)),
    ),
  ).then((settled) => {
    for (const s of settled) {
      if (s.status === "rejected") {
        const msg = s.reason instanceof Error ? s.reason.message : String(s.reason);
        log.warn(`bumpAccess failed: ${msg}`);
      }
    }
  });
}
