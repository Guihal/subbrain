/**
 * M-09: cross-layer dedup + archive→shared promote. Pure-cosine, no LLM.
 *
 * Runs AFTER `runMemoryDedup` + `decaySalience`, BEFORE `runReflect`.
 *
 * Pass 1 — supersedes edges across 3 layer pairs (context↔archive,
 * archive↔shared, context↔shared) with same-category match:
 * lower(context.title) ↔ lower(archive.title) ↔ lower(shared.category).
 * cos ≥ DUP_COSINE_MIN → newer (max updated_at) = live, older = stale.
 * Edge `kind='supersedes'`, `src=stale`, `dst=live`, `weight=1.0`. Stale row
 * in shared/context also gets `superseded_by = live.id`; archive has no
 * superseded_by column (M-07/M-12) so only the edge marks it.
 *
 * Pass 2 — archive → shared promote: archive row qualifies when
 * access_count ≥ ARCHIVE_PROMOTE_MIN_ACCESS, confidence ≥
 * ARCHIVE_PROMOTE_MIN_CONFIDENCE, and no existing shared row same-category
 * has cosine ≥ 0.85 (skip-guard mirrors M-06). Promotion via
 * `MemoryService.insertShared` (atomic embed-first, M-01) +
 * `derives` edge. Archive is NOT marked superseded after promote — rerun
 * idempotency relies on the skip-guard hitting the freshly inserted shared
 * row. Errors swallowed + counted, never thrown.
 */
import type { MemoryDB, SharedRow } from "../../../db";
import type { MemoryService } from "../../../services/memory.service";
import { logger } from "../../../lib/logger";

const log = logger.child("night.cross-layer");

const DUP_COSINE_MIN = 0.92; // supersede threshold per plan
const PROMOTE_SKIP_COSINE = 0.85; // skip-guard threshold (mirrors M-06 reflect)

export interface CrossLayerResult {
  pairs_examined: number;
  supersedes_added: number;
  promoted_to_shared: number;
  errors: number;
}

export interface CrossLayerDeps {
  memory: MemoryDB;
  memoryService: MemoryService;
}

interface Cfg {
  enabled: boolean;
  promoteMinAccess: number;
  promoteMinConfidence: number;
  candidateLimit: number;
}

function readEnv(): Cfg {
  const enabled = (process.env.CROSS_LAYER_DEDUP_ENABLED ?? "true").toLowerCase() !== "false";
  const a = parseInt(process.env.ARCHIVE_PROMOTE_MIN_ACCESS ?? "5", 10);
  const c = parseFloat(process.env.ARCHIVE_PROMOTE_MIN_CONFIDENCE ?? "0.7");
  const lim = parseInt(process.env.CROSS_LAYER_DEDUP_LIMIT ?? "200", 10);
  return {
    enabled,
    promoteMinAccess: Number.isFinite(a) && a >= 1 ? a : 5,
    promoteMinConfidence: Number.isFinite(c) && c >= 0 && c <= 1 ? c : 0.7,
    candidateLimit: Number.isFinite(lim) && lim >= 1 ? lim : 200,
  };
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

type Layer = "context" | "archive" | "shared";
interface Item { id: string; cat: string; updated_at: number; layer: Layer; }

// Most-recent N rows per layer. SQL lives in the repository layer
// (memory.repo.ts → tables/{memory,shared}.ts) per the layer-boundary
// guardrail; this step only orchestrates.
function mostRecent(memory: MemoryDB, layer: Layer, limit: number): Item[] {
  const rows = layer === "context"
    ? memory.memoryRepo.recentActiveContextForCrossLayer(limit)
    : layer === "archive"
    ? memory.memoryRepo.recentArchiveForCrossLayer(limit)
    : memory.memoryRepo.recentActiveSharedForCrossLayer(limit);
  return rows.map((r) => ({ id: r.id, cat: r.cat, updated_at: r.updated_at, layer }));
}

interface PairStat { pairs: number; supersedes: number; errors: number; }

function dedupPair(memory: MemoryDB, a: Item[], b: Item[]): PairStat {
  const stat: PairStat = { pairs: 0, supersedes: 0, errors: 0 };
  if (a.length === 0 || b.length === 0) return stat;
  const vecA = memory.getEmbeddingsByIds(a[0].layer, a.map((x) => x.id));
  const vecB = memory.getEmbeddingsByIds(b[0].layer, b.map((x) => x.id));
  for (const ai of a) {
    const av = vecA.get(ai.id);
    if (!av) continue;
    for (const bi of b) {
      if (ai.cat !== bi.cat) continue;
      const bv = vecB.get(bi.id);
      if (!bv) continue;
      stat.pairs++;
      if (cosineSimilarity(av, bv) < DUP_COSINE_MIN) continue;
      // newer = live, older = stale. Tie → keep `a` as live (deterministic).
      const live = ai.updated_at >= bi.updated_at ? ai : bi;
      const stale = ai.updated_at >= bi.updated_at ? bi : ai;
      try {
        const inserted = memory.linkEdge(stale.id, stale.layer, live.id, live.layer, "supersedes", 1.0);
        if (inserted) {
          if (stale.layer !== "archive") memory.setSupersededBy(stale.layer, stale.id, live.id);
          stat.supersedes++;
        }
      } catch (err) {
        stat.errors++;
        log.warn("supersede edge failed", { meta: { msg: (err as Error).message } });
      }
    }
  }
  return stat;
}

function isPromoteDup(memory: MemoryDB, av: Float32Array, cat: string): boolean {
  const neighbours = memory.searchEmbeddings(av, 5, "shared");
  const sharedVecs = memory.getEmbeddingsByIds("shared", neighbours.map((n) => n.id));
  for (const n of neighbours) {
    const sv = sharedVecs.get(n.id);
    if (!sv || cosineSimilarity(av, sv) < PROMOTE_SKIP_COSINE) continue;
    const row = memory.getShared(n.id) as SharedRow | null;
    if (row && row.category.toLowerCase() === cat) return true;
  }
  return false;
}

async function promoteArchiveToShared(deps: CrossLayerDeps, cfg: Cfg): Promise<{ promoted: number; errors: number; }> {
  const { memory, memoryService } = deps;
  let promoted = 0, errors = 0;
  const candidates = memory.memoryRepo.archivePromoteCandidates(
    cfg.promoteMinAccess,
    cfg.promoteMinConfidence,
    cfg.candidateLimit,
  );
  if (candidates.length === 0) return { promoted, errors };
  const vecA = memory.getEmbeddingsByIds("archive", candidates.map((c) => c.id));
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
      memory.linkEdge(arc.id, "archive", newId, "shared", "derives", 1.0);
      promoted++;
    } catch (err) {
      errors++;
      log.warn("promote failed", { meta: { archive_id: arc.id.slice(0, 8), msg: (err as Error).message } });
    }
  }
  return { promoted, errors };
}

export async function runCrossLayerDedup(deps: CrossLayerDeps): Promise<CrossLayerResult> {
  const cfg = readEnv();
  const r: CrossLayerResult = { pairs_examined: 0, supersedes_added: 0, promoted_to_shared: 0, errors: 0 };
  if (!cfg.enabled) { log.info("disabled (CROSS_LAYER_DEDUP_ENABLED=false)"); return r; }
  const ctx = mostRecent(deps.memory, "context", cfg.candidateLimit);
  const arc = mostRecent(deps.memory, "archive", cfg.candidateLimit);
  const shr = mostRecent(deps.memory, "shared", cfg.candidateLimit);
  const settled = await Promise.allSettled<PairStat>([
    Promise.resolve(dedupPair(deps.memory, ctx, arc)),
    Promise.resolve(dedupPair(deps.memory, arc, shr)),
    Promise.resolve(dedupPair(deps.memory, ctx, shr)),
  ]);
  for (const s of settled) {
    if (s.status === "fulfilled") {
      r.pairs_examined += s.value.pairs; r.supersedes_added += s.value.supersedes; r.errors += s.value.errors;
    } else {
      r.errors++; log.warn("pair failed", { meta: { msg: String(s.reason) } });
    }
  }
  const p = await promoteArchiveToShared(deps, cfg);
  r.promoted_to_shared = p.promoted; r.errors += p.errors;
  log.info(`done: pairs=${r.pairs_examined} supersedes=${r.supersedes_added} promoted=${r.promoted_to_shared} errors=${r.errors}`);
  return r;
}
