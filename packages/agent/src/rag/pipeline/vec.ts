import type { MemoryDB } from "@subbrain/core/db";
import type { RAGResult } from "../types";

interface RowFields {
  title: string;
  content: string;
  created_at?: number;
  updated_at?: number;
  kind?: string;
  salience?: number;
  // M-08: access columns hydrated from SELECT * in get*Many helpers.
  last_accessed_at?: number | null;
  access_count?: number;
}

/**
 * Vector-only search (1 RPM for embedding, cached).
 *
 * B-1: `agentId` filters context-layer hydration; archive + shared ignore.
 *
 * Hydration is per-layer: one batch SELECT for context/archive/shared/log
 * keyed by id. M-07 `kind` is shared-only; M-03 `salience` is hydrated for
 * all three layers (mig 13 columns).
 *
 * MEM-5 (PR 22a): vec search can return ids whose rows are pending /
 * rejected (vec_embeddings has no status column). `activeOnly` drops them
 * at hydrate time so they never enter RAG injection.
 *
 * P3-3: bi-temporal filter applied via buildActiveFilter:
 * (valid_from IS NULL OR valid_from <= unixepoch()) AND (valid_to IS NULL OR valid_to > unixepoch())
 */
export async function vecSearch(
  memory: MemoryDB,
  embedQuery: (q: string) => Promise<Float32Array>,
  query: string,
  layers: string[],
  limit: number,
  agentId?: string,
): Promise<RAGResult[]> {
  const queryVec = await embedQuery(query);
  const results: RAGResult[] = [];

  for (const layer of layers) {
    const vecResults = memory.searchEmbeddings(queryVec, limit, layer);
    if (vecResults.length === 0) continue;

    const ids = vecResults.map((v) => v.id);
    const byId = new Map<string, RowFields>();

    if (layer === "context") {
      for (const r of memory.getContextMany(ids, { activeOnly: true, notStale: true, agentId })) {
        byId.set(r.id, {
          title: r.title,
          content: r.content,
          created_at: r.created_at,
          updated_at: r.updated_at,
          salience: r.salience,
          last_accessed_at: r.last_accessed_at,
          access_count: r.access_count,
        });
      }
    } else if (layer === "archive") {
      for (const r of memory.getArchiveMany(ids)) {
        byId.set(r.id, {
          title: r.title,
          content: r.content,
          created_at: r.created_at,
          updated_at: r.updated_at,
          salience: r.salience,
          last_accessed_at: r.last_accessed_at,
          access_count: r.access_count,
        });
      }
    } else if (layer === "shared") {
      for (const r of memory.getSharedMany(ids, { activeOnly: true, notStale: true })) {
        byId.set(r.id, {
          title: r.category,
          content: r.content,
          created_at: r.created_at,
          updated_at: r.updated_at,
          // M-07/M-03/M-08: persona boost / salience boost / forgetting-curve.
          kind: r.kind,
          salience: r.salience,
          last_accessed_at: r.last_accessed_at,
          access_count: r.access_count,
        });
      }
    } else if (layer === "log") {
      // M-04.1: hydrate via LogRepository (raw SQL stays in db/tables per
      // PR 27). No status column on layer4_log → all rows hydrate; privacy
      // enforced upstream (log only enters when caller passes layers=[..., "log"]).
      for (const r of memory.logRepo.hydrateForVec(ids)) {
        byId.set(r.id, {
          title: r.role,
          content: r.content,
          created_at: r.created_at,
          // No `updated_at` on log rows — reuse created_at so the
          // forgetting-curve / recency-boost branches see a sensible age.
          updated_at: r.created_at,
        });
      }
    }

    for (const vr of vecResults) {
      const row = byId.get(vr.id);
      // MEM-5: context/shared hydrate with activeOnly — missing row = status
      // != 'active'. Skip so pending rows never reach RAG. Archive (no status
      // col) always hydrates, so row presence is fine.
      if (!row && (vr.layer === "context" || vr.layer === "shared")) continue;
      results.push({
        id: vr.id,
        layer: vr.layer,
        title: row?.title ?? vr.id,
        snippet: row ? row.content.substring(0, 300) : "",
        score: 1 / (1 + vr.distance),
        created_at: row?.created_at,
        updated_at: row?.updated_at,
        kind: row?.kind,
        salience: row?.salience,
        last_accessed_at: row?.last_accessed_at,
        access_count: row?.access_count,
      });
    }
  }

  return results;
}
