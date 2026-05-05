/** MEM-6: pre-insert dedup for hippocampus. Two-pass: FTS5 → embed → vec. */
import type { MemoryDB } from "../../../db";
import type { RAGPipeline } from "../../../rag";

const FTS_SEARCH_LIMIT = 5;
const VEC_SEARCH_LIMIT = 5;
const MIN_OVERLAP_TOKENS = 5;
// Cosine threshold (computed in JS post-search; sqlite-vec returns L2, not
// cosine, on un-normalised vectors). 0.85 = "near-duplicate same fact".
const DUP_COSINE_MIN = 0.85;
const EMBED_TIMEOUT_MS = 5000;
const FTS_QUERY_HEAD = 200;

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

// Token splitter: lowercase, drop non-letters/digits, drop length ≤ 2,
// drop trivial Russian/English stop-words. Cheap heuristic — cosine handles
// the precision case.
const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "you",
  "are",
  "with",
  "from",
  "this",
  "that",
  "have",
  "был",
  "была",
  "была",
  "это",
  "тот",
  "так",
  "его",
  "как",
  "что",
  "уже",
  "для",
  "при",
  "или",
  "под",
  "над",
  "без",
  "между",
]);

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-zа-я0-9 ]+/giu, " ")
    .split(/\s+/u)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
}

function tokenOverlap(a: string, b: string): number {
  const ta = new Set(tokenize(a));
  if (ta.size === 0) return 0;
  let overlap = 0;
  for (const t of tokenize(b)) if (ta.has(t)) overlap++;
  return overlap;
}

export interface DupCandidate {
  id: string | null;
  source: "fts" | "vec" | null;
  vec: Float32Array | null;
  embedFailed: boolean;
  embedError?: string;
}

/** Find duplicate row in `layer` for new (category, content). */
export async function findDuplicate(
  memory: MemoryDB,
  rag: RAGPipeline,
  layer: "shared" | "context",
  category: string,
  content: string,
): Promise<DupCandidate> {
  const cat = category.trim().toLowerCase();
  const head = content.slice(0, FTS_QUERY_HEAD);

  // 1. FTS pass (RPM-free).
  try {
    const ftsHits =
      layer === "shared"
        ? memory.searchShared(head, FTS_SEARCH_LIMIT, {
            activeOnly: true,
            notStale: true,
          })
        : memory.searchContext(head, FTS_SEARCH_LIMIT, {
            activeOnly: true,
            notStale: true,
          });

    for (const hit of ftsHits) {
      // For shared, FTS `title` is `category`. For context, hit.title is the
      // row title — we still need to fetch the actual category. Cheap getRow
      // batched per hit (typical 1-3 hits).
      let hitCat = "";
      let hitContent = "";
      if (layer === "shared") {
        const row = memory.getShared(hit.id);
        if (!row) continue;
        hitCat = row.category.toLowerCase();
        hitContent = row.content;
      } else {
        const row = memory.getContext(hit.id);
        if (!row) continue;
        hitCat = row.title.toLowerCase();
        hitContent = row.content;
      }
      if (hitCat !== cat) continue;
      if (tokenOverlap(content, hitContent) >= MIN_OVERLAP_TOKENS) {
        return { id: hit.id, source: "fts", vec: null, embedFailed: false };
      }
    }
  } catch {
    // FTS sanitize/internal error → fall through to vec; never throw from
    // dedupe (worst case is a duplicate row, never a failed write).
  }

  // 2. Vec pass: embed once. On failure, caller MUST fail fast — re-trying
  // the same content would just hit the same timeout/error.
  let vec: Float32Array;
  try {
    vec = await rag.embedContent(content, AbortSignal.timeout(EMBED_TIMEOUT_MS));
  } catch (err) {
    const em = err instanceof Error ? err.message : String(err);
    return { id: null, source: null, vec: null, embedFailed: true, embedError: em };
  }
  if (!vec || vec.length === 0) {
    return { id: null, source: null, vec: null, embedFailed: true, embedError: "embed_empty" };
  }

  try {
    const vecHits = memory.searchEmbeddings(vec, VEC_SEARCH_LIMIT, layer);
    const nowSec = Math.floor(Date.now() / 1000);
    for (const v of vecHits) {
      // sqlite-vec returns L2 on un-normalised vectors, not cosine — so we
      // re-rank in JS. Hydrate the candidate's vec via a single SELECT and
      // compute cosine; only accept hits ≥ DUP_COSINE_MIN with same category.
      let hitCat = "";
      let hitContent = "";
      if (layer === "shared") {
        const row = memory.getShared(v.id);
        if (!row || row.superseded_by !== null) continue;
        if (row.expires_at !== null && row.expires_at <= nowSec) continue;
        hitCat = row.category.toLowerCase();
        hitContent = row.content;
      } else {
        const row = memory.getContext(v.id);
        if (!row || row.superseded_by !== null) continue;
        if (row.expires_at !== null && row.expires_at <= nowSec) continue;
        hitCat = row.title.toLowerCase();
        hitContent = row.content;
      }
      if (hitCat !== cat) continue;
      // Re-embed the candidate to compute cosine in JS — sqlite-vec stores
      // un-normalised vectors so its L2 metric is not equivalent to
      // 1-cosine. Cheap (≤ VEC_SEARCH_LIMIT extra calls, only on FTS miss).
      // Stability: NVIDIA NIM nv-embed (`EMBED_MODEL`) is deterministic for
      // the same input, so candVec ≈ stored embedding for `hitContent`;
      // tiny floating-point drift won't push true duplicates below 0.85.
      let candVec: Float32Array;
      try {
        candVec = await rag.embedContent(hitContent, AbortSignal.timeout(EMBED_TIMEOUT_MS));
      } catch {
        continue;
      }
      if (cosineSimilarity(vec, candVec) >= DUP_COSINE_MIN) {
        return { id: v.id, source: "vec", vec, embedFailed: false };
      }
    }
  } catch {
    // searchEmbeddings can throw on dim mismatch — fall through.
  }

  return { id: null, source: null, vec, embedFailed: false };
}

/** Pick more informative content. "Longest wins". */
export function mergeContent(oldContent: string, newContent: string): string {
  return newContent.length > oldContent.length ? newContent : oldContent;
}

/** Union two CSV tag strings, case-insensitive dedup. */
export function mergeTags(oldTags: string, newTags: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...oldTags.split(","), ...newTags.split(",")]) {
    const t = raw.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out.join(",");
}

/** Bump confidence on update — capped at 1.0. */
export function bumpConfidence(oldConf: number | null, newConf: number): number {
  return Math.min(1, Math.max(oldConf ?? 0, newConf) + 0.05);
}
