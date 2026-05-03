/**
 * PR-A: on-write dedup helper for shared/context layers.
 *
 * Per-category mode (single source: MEMORY_DEDUP_MODE_BY_CATEGORY in validators.ts):
 *   strict   — cosine ≥ 0.92 → reject as duplicate; <0.92 → fresh.
 *   supersede — cosine ≥ 0.95 → reject; 0.85–0.95 → insert + soft-archive old; <0.85 → fresh.
 *
 * Uses embed-first + sqlite-vec top-3 in same layer (no FTS — vec is the
 * ground truth for semantic similarity). Cosine computed in JS from raw
 * Float32Array vectors (sqlite-vec returns L2 on un-normalised vectors).
 */
import type { MemoryDB } from "../../db";
import type { RAGPipeline } from "../../rag";
import {
  MEMORY_DEDUP_MODE_BY_CATEGORY,
} from "../../pipeline/agent-pipeline/post/validators";

const EMBED_TIMEOUT_MS = 5000;
const VEC_TOP = 3;
const STRICT_REJECT_COSINE = 0.92;
const SUPERSEDE_REJECT_COSINE = 0.95;
const SUPERSEDE_ARCHIVE_COSINE = 0.85;

export type DedupAction = "reject" | "supersede" | "fresh";

export interface DedupResult {
  action: DedupAction;
  /** id of existing row to soft-archive (supersede mode only). */
  supersedesId?: string;
  similarity?: number;
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/**
 * Check whether `content` is a duplicate of an existing row in `layer/category`.
 * Pass `embedding` if already computed (avoids double-embed in write path).
 */
export async function checkDuplicate(
  memory: MemoryDB,
  rag: RAGPipeline,
  layer: "shared" | "context",
  category: string,
  content: string,
  embedding?: Float32Array,
): Promise<DedupResult> {
  const cat = category.trim().toLowerCase();
  const mode = MEMORY_DEDUP_MODE_BY_CATEGORY[cat] ?? "supersede";

  // Embed candidate (reuse if provided).
  let vec: Float32Array;
  try {
    vec = embedding ?? await rag.embedContent(content, AbortSignal.timeout(EMBED_TIMEOUT_MS));
  } catch {
    // Embed unavailable → skip dedup, let write proceed.
    return { action: "fresh" };
  }
  if (!vec || vec.length === 0) return { action: "fresh" };

  // Top-3 vec neighbours in same layer.
  let candidates: { id: string; distance: number }[];
  try {
    candidates = memory.searchEmbeddings(vec, VEC_TOP, layer);
  } catch {
    return { action: "fresh" };
  }

  const nowSec = Math.floor(Date.now() / 1000);

  for (const c of candidates) {
    // Hydrate row to check category + stale status.
    let rowCat = "";
    let rowVec: Float32Array | undefined;
    if (layer === "shared") {
      const row = memory.getShared(c.id);
      if (!row || row.superseded_by !== null) continue;
      if (row.expires_at !== null && row.expires_at <= nowSec) continue;
      rowCat = row.category.toLowerCase();
    } else {
      const row = memory.getContext(c.id);
      if (!row || row.superseded_by !== null) continue;
      if (row.expires_at !== null && row.expires_at <= nowSec) continue;
      // For context, category is stored in `title` (per existing dedupe.ts convention).
      rowCat = row.title.toLowerCase();
    }
    if (rowCat !== cat) continue;

    // Fetch stored embedding for cosine in JS.
    const embMap = memory.getEmbeddingsByIds(layer, [c.id]);
    rowVec = embMap.get(c.id);
    if (!rowVec) continue;

    const sim = cosineSimilarity(vec, rowVec);

    if (mode === "strict") {
      if (sim >= STRICT_REJECT_COSINE) return { action: "reject", similarity: sim };
    } else {
      // supersede mode
      if (sim >= SUPERSEDE_REJECT_COSINE) return { action: "reject", similarity: sim };
      if (sim >= SUPERSEDE_ARCHIVE_COSINE) return { action: "supersede", supersedesId: c.id, similarity: sim };
    }
  }

  return { action: "fresh" };
}
