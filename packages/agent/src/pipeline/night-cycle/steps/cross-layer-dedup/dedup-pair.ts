import type { MemoryDB } from "@subbrain/core/db";
import { logger } from "@subbrain/core/lib/logger";
import { DUP_COSINE_MIN, safeMessage, WEIGHT_SUPERSEDES } from "./config";
import { cosineSimilarity } from "./cosine";

const log = logger.child("night.cross-layer");

export type Layer = "context" | "archive" | "shared";

export interface Item {
  id: string;
  cat: string;
  updated_at: number;
  layer: Layer;
}

export interface PairStat {
  pairs: number;
  supersedes: number;
  errors: number;
}

export function mostRecent(memory: MemoryDB, layer: Layer, limit: number): Item[] {
  const rows =
    layer === "context"
      ? memory.memoryRepo.recentActiveContextForCrossLayer(limit)
      : layer === "archive"
        ? memory.memoryRepo.recentArchiveForCrossLayer(limit)
        : memory.memoryRepo.recentActiveSharedForCrossLayer(limit);
  return rows.map((r) => ({ id: r.id, cat: r.cat, updated_at: r.updated_at, layer }));
}

function insertSupersedeEdge(memory: MemoryDB, stale: Item, live: Item): boolean {
  const inserted = memory.linkEdge(
    stale.id,
    stale.layer,
    live.id,
    live.layer,
    "supersedes",
    WEIGHT_SUPERSEDES,
  );
  if (inserted && stale.layer !== "archive") {
    memory.setSupersededBy(stale.layer, stale.id, live.id);
  }
  return inserted;
}

export function dedupPair(memory: MemoryDB, a: Item[], b: Item[]): PairStat {
  const stat: PairStat = { pairs: 0, supersedes: 0, errors: 0 };
  if (a.length === 0 || b.length === 0) return stat;
  const vecA = memory.getEmbeddingsByIds(
    a[0].layer,
    a.map((x) => x.id),
  );
  const vecB = memory.getEmbeddingsByIds(
    b[0].layer,
    b.map((x) => x.id),
  );
  for (const ai of a) {
    const av = vecA.get(ai.id);
    if (!av) continue;
    for (const bi of b) {
      if (ai.cat !== bi.cat) continue;
      const bv = vecB.get(bi.id);
      if (!bv) continue;
      stat.pairs++;
      if (cosineSimilarity(av, bv) < DUP_COSINE_MIN) continue;
      const live = ai.updated_at >= bi.updated_at ? ai : bi;
      const stale = ai.updated_at >= bi.updated_at ? bi : ai;
      try {
        insertSupersedeEdge(memory, stale, live);
        stat.supersedes++;
      } catch (err) {
        stat.errors++;
        log.warn("supersede edge failed", { meta: { msg: safeMessage(err) } });
      }
    }
  }
  return stat;
}
