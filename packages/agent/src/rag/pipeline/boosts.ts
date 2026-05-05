import type { MemoryDB } from "@subbrain/core/db";
import { logger } from "@subbrain/core/lib/logger";
import type { RAGResult } from "../types";

const log = logger.child("rag");

const PERSONA_BOOST = 1.1;
const EDGE_WALK_BOOST = 1.08;
export const SALIENCE_BOOST_FACTOR = 0.1;

type BumpLayer = "shared" | "context" | "archive";
function isBumpLayer(l: string): l is BumpLayer {
  return l === "shared" || l === "context" || l === "archive";
}

function bumpAccessEnabled(): boolean {
  return process.env.RAG_BUMP_ACCESS !== "false";
}

export function applyPersonaBoost(results: RAGResult[]): RAGResult[] {
  if (results.length === 0) return results;
  const boosted = results.map((r) =>
    r.layer === "shared" && r.kind === "persona" ? { ...r, score: r.score * PERSONA_BOOST } : r,
  );
  boosted.sort((a, b) => b.score - a.score);
  return boosted;
}

export function applySalienceBoost(results: RAGResult[]): RAGResult[] {
  if (results.length === 0) return results;
  const boosted = results.map((r) => {
    const salience = r.salience ?? 0.5;
    return { ...r, score: r.score * (1 + SALIENCE_BOOST_FACTOR * salience) };
  });
  boosted.sort((a, b) => b.score - a.score);
  return boosted;
}

export function applyEdgeWalkBoost(
  results: RAGResult[],
  memory: MemoryDB,
): RAGResult[] {
  if (results.length === 0) return results;
  const reachable = new Set<string>();
  for (const r of results) {
    if (!isBumpLayer(r.layer)) continue;
    const neighbours = memory.getRelated(r.id, r.layer, 1);
    for (const n of neighbours) {
      reachable.add(`${n.layer}:${n.id}`);
    }
  }
  const boosted = results.map((r) => {
    const personaFactor = r.layer === "shared" && r.kind === "persona" ? PERSONA_BOOST : 1;
    const salienceFactor = 1 + SALIENCE_BOOST_FACTOR * (r.salience ?? 0.5);
    const edgeFactor = reachable.has(`${r.layer}:${r.id}`) ? EDGE_WALK_BOOST : 1;
    const factor = Math.max(personaFactor, salienceFactor, edgeFactor);
    return { ...r, score: r.score * factor };
  });
  boosted.sort((a, b) => b.score - a.score);
  return boosted;
}

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
