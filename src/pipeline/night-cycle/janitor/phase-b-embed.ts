/**
 * PR-B Phase B helper — pre-compute embeddings for dedup candidates.
 * Tries sqlite-vec cache first (production rows have stored vectors), falls
 * back to rag.embedContent for missing ids (e.g. unit tests inserting raw
 * rows without indexEntry). Pure-math `cosine()` consumes the resulting Map.
 */
import type { MemoryDB } from "../../../db";
import type { RAGPipeline } from "../../../rag";

export type LayerName = "shared" | "context";

export interface EmbedCandidate {
  id: string;
  content: string;
}

/** Pure cosine on pre-computed Float32Array pairs. */
export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] ** 2;
    nb += b[i] ** 2;
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/**
 * One pass per phase-B run: lookup cached vectors, then Promise.allSettled
 * for misses. Failed embeds are simply absent from the returned Map; callers
 * skip rows whose vector is missing.
 */
export async function buildEmbeddingMap(
  memory: MemoryDB,
  rag: RAGPipeline,
  layer: LayerName,
  rows: readonly EmbedCandidate[],
): Promise<Map<string, Float32Array>> {
  const ids = rows.map((r) => r.id);
  const cached = memory.getEmbeddingsByIds(layer, ids);
  const missing = rows.filter((r) => !cached.has(r.id));
  if (missing.length === 0) return cached;
  const settled = await Promise.allSettled(missing.map((r) => rag.embedContent(r.content)));
  for (let i = 0; i < missing.length; i++) {
    const s = settled[i];
    if (s.status === "fulfilled") cached.set(missing[i].id, s.value);
  }
  return cached;
}
