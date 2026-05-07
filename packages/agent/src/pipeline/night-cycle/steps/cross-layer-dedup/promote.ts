import type { MemoryDB } from "@subbrain/core/db";
import { logger } from "@subbrain/core/lib/logger";
import type { MemoryService } from "../../../../services/memory";
import type { Cfg } from "./config";
import { PROMOTE_SKIP_COSINE, safeMessage, WEIGHT_DERIVES } from "./config";
import { cosineSimilarity } from "./cosine";

const log = logger.child("night.cross-layer");

export interface CrossLayerDeps {
  memory: MemoryDB;
  memoryService: MemoryService;
}

function isPromoteDup(memory: MemoryDB, av: Float32Array, cat: string): boolean {
  const neighbours = memory.searchEmbeddings(av, 5, "shared");
  if (neighbours.length === 0) return false;
  const sharedVecs = memory.getEmbeddingsByIds(
    "shared",
    neighbours.map((n) => n.id),
  );
  const rows = memory.getSharedMany(neighbours.map((n) => n.id));
  for (const n of neighbours) {
    const sv = sharedVecs.get(n.id);
    if (!sv || cosineSimilarity(av, sv) < PROMOTE_SKIP_COSINE) continue;
    const row = rows.find((r) => r.id === n.id);
    if (row && row.category.toLowerCase() === cat) return true;
  }
  return false;
}

export async function promoteArchiveToShared(
  deps: CrossLayerDeps,
  cfg: Cfg,
): Promise<{ promoted: number; errors: number }> {
  const { memory, memoryService } = deps;
  let promoted = 0,
    errors = 0;
  const candidates = memory.memoryRepo.archivePromoteCandidates(
    cfg.promoteMinAccess,
    cfg.promoteMinConfidence,
    cfg.candidateLimit,
  );
  if (candidates.length === 0) return { promoted, errors };
  const vecA = memory.getEmbeddingsByIds(
    "archive",
    candidates.map((c) => c.id),
  );
  for (const arc of candidates) {
    const av = vecA.get(arc.id);
    if (!av) continue;
    try {
      if (isPromoteDup(memory, av, arc.title.toLowerCase())) continue;
      const newId = await memoryService.insertShared({
        category: arc.title,
        content: arc.content,
        tags: arc.tags ?? "",
        source: "archive-promote",
        kind: "semantic",
        confidence: arc.confidence ?? null,
      });
      memory.linkEdge(arc.id, "archive", newId, "shared", "derives", WEIGHT_DERIVES);
      promoted++;
    } catch (err) {
      errors++;
      log.warn("promote failed", {
        meta: { archive_id: arc.id.slice(0, 8), msg: safeMessage(err) },
      });
    }
  }
  return { promoted, errors };
}
