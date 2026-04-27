import { Database } from "bun:sqlite";
import { sanitizeFtsQuery } from "../../../lib/fts-utils";
import type { FtsResult, VecResult } from "../../types";
import { buildActiveFilter } from "./helpers";

/**
 * FTS5 search on shared_memory. `activeOnly` (PR 22a / MEM-5) filters by
 * status = 'active'. `notStale` (MEM-6, mig 9) filters out superseded /
 * expired rows. Both apply at JOIN-time on shared_memory; the FTS mirror
 * has no status/expires/superseded columns and is not rebuilt.
 *
 * B-1 note: shared_memory has no `agent_id` column (see schema.ts). The
 * table is by-design global — accepted writers (post-hippocampus
 * `writeShared`, context-compressor) intentionally publish facts visible
 * to every agent. Per-agent privacy lives in the separate `agent_memory`
 * table (`getAgentMemories` filter). Adding agent isolation here would
 * require schema work + writer updates and is out of scope.
 *
 * M-07: SELECT `s.kind` so RAG can apply persona boost without round-trip.
 * M-03 (mig 13): SELECT `s.salience` for RAG salience-boost.
 * M-08: SELECT `s.last_accessed_at, s.access_count` for forgetting curve.
 */
export function searchShared(
  db: Database,
  query: string,
  limit: number,
  opts: { activeOnly?: boolean; notStale?: boolean } | undefined,
): FtsResult[] {
  const ftsQuery = sanitizeFtsQuery(query);
  if (!ftsQuery) return [];
  const filter = buildActiveFilter("s", opts);
  return db
    .query(
      `SELECT s.id, s.category AS title, s.tags, snippet(fts_shared, 1, '<b>', '</b>', '...', 32) AS snippet, rank, s.created_at, s.updated_at, s.kind, s.salience, s.last_accessed_at, s.access_count FROM fts_shared f JOIN shared_memory s ON s.rowid = f.rowid WHERE fts_shared MATCH ?${filter} ORDER BY rank LIMIT ?`,
    )
    .all(ftsQuery, limit) as FtsResult[];
}

// ─── Vector Search (sqlite-vec) ────────────────────────────

export function upsertEmbedding(
  db: Database,
  id: string,
  layer: string,
  embedding: Float32Array,
): void {
  db.query(
    "INSERT OR REPLACE INTO vec_embeddings (id, layer, embedding) VALUES (?, ?, ?)",
  ).run(id, layer, new Uint8Array(embedding.buffer));
}

export function searchEmbeddings(
  db: Database,
  embedding: Float32Array,
  limit: number,
  layer?: string,
): VecResult[] {
  const blob = new Uint8Array(embedding.buffer);
  if (layer) {
    return db
      .query(
        "SELECT id, layer, distance FROM vec_embeddings WHERE embedding MATCH ? AND layer = ? ORDER BY distance LIMIT ?",
      )
      .all(blob, layer, limit) as VecResult[];
  }
  return db
    .query(
      "SELECT id, layer, distance FROM vec_embeddings WHERE embedding MATCH ? ORDER BY distance LIMIT ?",
    )
    .all(blob, limit) as VecResult[];
}

export function deleteEmbedding(db: Database, id: string): void {
  db.query("DELETE FROM vec_embeddings WHERE id = ?").run(id);
}

/**
 * M-09: most-recent active+fresh shared rows for cross-layer dedup. Returns
 * `cat = lower(category)` so the caller can match against context.title /
 * archive.title without a second pass.
 */
export function recentActiveSharedForCrossLayer(
  db: Database,
  limit: number,
): { id: string; cat: string; updated_at: number }[] {
  return db
    .query<{ id: string; cat: string; updated_at: number }, [number]>(
      "SELECT id, lower(category) AS cat, updated_at FROM shared_memory WHERE status='active' AND superseded_by IS NULL AND (expires_at IS NULL OR expires_at > unixepoch()) ORDER BY updated_at DESC LIMIT ?",
    )
    .all(limit);
}

/**
 * M-09: bulk-fetch raw embedding vectors for given ids in a layer. Used by
 * the cross-layer dedup step to compute cosine in JS (sqlite-vec returns L2
 * on un-normalised vectors per audit). Empty ids → empty Map. Callers cap
 * `ids.length` (CROSS_LAYER_DEDUP_LIMIT) so the IN(?,?,…) clause stays
 * SQLite-friendly. Missing ids are simply absent from the returned Map.
 */
export function getEmbeddingsByIds(
  db: Database,
  layer: string,
  ids: string[],
): Map<string, Float32Array> {
  const out = new Map<string, Float32Array>();
  if (ids.length === 0) return out;
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .query(
      `SELECT id, embedding FROM vec_embeddings WHERE layer = ? AND id IN (${placeholders})`,
    )
    .all(layer, ...ids) as { id: string; embedding: Uint8Array }[];
  for (const r of rows) {
    const blob = r.embedding;
    if (!blob || blob.byteLength % 4 !== 0) continue;
    out.set(
      r.id,
      new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4),
    );
  }
  return out;
}
