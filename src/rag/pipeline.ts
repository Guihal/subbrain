import type { MemoryDB, FtsResult, VecResult } from "../db";
import type { ModelRouter } from "../lib/model-router";
import { EMBED_MODEL, RERANK_MODEL } from "../lib/model-map";
import {
  RRF_K,
  EMBED_CACHE_MAX,
  EMBED_CACHE_TTL,
  sanitizeFtsQuery,
  type RAGResult,
  type RAGSearchOptions,
} from "./types";

export type { RAGResult, RAGSearchOptions } from "./types";

function dedupeById(results: RAGResult[]): RAGResult[] {
  const seen = new Map<string, RAGResult>();
  for (const r of results) if (!seen.has(r.id)) seen.set(r.id, r);
  return [...seen.values()];
}

/**
 * Hybrid RAG pipeline: FTS5 + Vector search → RRF merge → Rerank.
 * Consumes 1-2 RPM per search (embed + optional rerank).
 * Includes LRU embedding cache to reduce RPM usage.
 */
export class RAGPipeline {
  private embedCache = new Map<string, { vec: Float32Array; ts: number }>();

  constructor(
    private memory: MemoryDB,
    private router: ModelRouter,
  ) {}

  /**
   * Full hybrid search: FTS5 + vector → RRF → rerank.
   */
  async search(opts: RAGSearchOptions): Promise<RAGResult[]> {
    const {
      query,
      layers = ["context", "archive", "shared"],
      ftsLimit = 20,
      vecLimit = 20,
      rerankTopN = 5,
      skipRerank = false,
    } = opts;

    // 1. FTS5 search (local, no RPM cost)
    const ftsResults = this.ftsSearch(query, layers, ftsLimit);

    // 2. Vector search (1 RPM for embed) — graceful degradation
    let vecResults: RAGResult[] = [];
    try {
      vecResults = await this.vecSearch(query, layers, vecLimit);
    } catch {
      // Vector search unavailable — continue with FTS-only
    }

    // 3. RRF Merge (dedup each source — FTS and vec can emit same id twice
    // across layers or via union with tags; rrfMerge expects first-seen rank)
    const merged = this.rrfMerge(
      dedupeById(ftsResults),
      dedupeById(vecResults),
    );

    // 4. Rerank top candidates (1 RPM) — graceful degradation
    if (skipRerank || merged.length <= 1) {
      return merged.slice(0, rerankTopN);
    }

    try {
      return await this.rerank(query, merged, rerankTopN);
    } catch {
      return merged.slice(0, rerankTopN);
    }
  }

  /**
   * FTS5-only search (no RPM cost, fast).
   */
  ftsSearch(query: string, layers: string[], limit: number): RAGResult[] {
    const ftsQuery = sanitizeFtsQuery(query);
    if (!ftsQuery) return [];

    const results: RAGResult[] = [];

    // MEM-5 (PR 22a): RAG injection must see only approved ('active') facts;
    // pending / rejected rows are filtered at SQL level inside searchContext /
    // searchShared. Archive has no status column — unchanged.
    if (layers.includes("context")) {
      for (const r of this.memory.searchContext(ftsQuery, limit, { activeOnly: true })) {
        results.push({
          id: r.id,
          layer: "context",
          title: r.title,
          snippet: r.snippet,
          score: 0,
          created_at: r.created_at,
          updated_at: r.updated_at,
        });
      }
    }
    if (layers.includes("archive")) {
      for (const r of this.memory.searchArchive(ftsQuery, limit)) {
        results.push({
          id: r.id,
          layer: "archive",
          title: r.title,
          snippet: r.snippet,
          score: 0,
          created_at: r.created_at,
          updated_at: r.updated_at,
        });
      }
    }
    if (layers.includes("shared")) {
      for (const r of this.memory.searchShared(ftsQuery, limit, { activeOnly: true })) {
        results.push({
          id: r.id,
          layer: "shared",
          title: r.title,
          snippet: r.snippet,
          score: 0,
          created_at: r.created_at,
          updated_at: r.updated_at,
        });
      }
    }

    return results;
  }

  /**
   * Vector-only search (1 RPM for embedding, cached).
   */
  async vecSearch(
    query: string,
    layers: string[],
    limit: number,
  ): Promise<RAGResult[]> {
    // Embed the query (with cache)
    const queryVec = await this.embedQuery(query);
    const results: RAGResult[] = [];

    for (const layer of layers) {
      const vecResults = this.memory.searchEmbeddings(queryVec, limit, layer);
      if (vecResults.length === 0) continue;

      const ids = vecResults.map((v) => v.id);
      // One batch SELECT per layer, keyed by id.
      const byId = new Map<
        string,
        { title: string; content: string; created_at?: number; updated_at?: number }
      >();
      // MEM-5 (PR 22a): vec search can return ids whose rows are pending /
      // rejected (the vec_embeddings table has no status column). activeOnly
      // drops them at hydrate time so they never enter RAG injection.
      if (layer === "context") {
        for (const r of this.memory.getContextMany(ids, { activeOnly: true })) byId.set(r.id, r);
      } else if (layer === "archive") {
        for (const r of this.memory.getArchiveMany(ids)) byId.set(r.id, r);
      } else if (layer === "shared") {
        for (const r of this.memory.getSharedMany(ids, { activeOnly: true })) {
          byId.set(r.id, {
            title: r.category,
            content: r.content,
            created_at: r.created_at,
            updated_at: r.updated_at,
          });
        }
      }

      for (const vr of vecResults) {
        const row = byId.get(vr.id);
        // MEM-5 (PR 22a): context/shared hydrate with activeOnly — a missing
        // row means status != 'active'. Skip so pending rows never reach RAG.
        // Archive (no status col) always hydrates, so row presence is fine.
        if (!row && (vr.layer === "context" || vr.layer === "shared")) continue;
        results.push({
          id: vr.id,
          layer: vr.layer,
          title: row?.title ?? vr.id,
          snippet: row ? row.content.substring(0, 300) : "",
          score: 1 / (1 + vr.distance),
          created_at: row?.created_at,
          updated_at: row?.updated_at,
        });
      }
    }

    return results;
  }

  // ─── RRF Merge ─────────────────────────────────────────

  private rrfMerge(
    ftsResults: RAGResult[],
    vecResults: RAGResult[],
  ): RAGResult[] {
    const scores = new Map<string, { result: RAGResult; score: number }>();

    // Score FTS results by rank position
    for (let i = 0; i < ftsResults.length; i++) {
      const r = ftsResults[i];
      const rrfScore = 1 / (RRF_K + i + 1);
      const existing = scores.get(r.id);
      if (existing) {
        existing.score += rrfScore;
      } else {
        scores.set(r.id, { result: r, score: rrfScore });
      }
    }

    // Score vector results by rank position
    for (let i = 0; i < vecResults.length; i++) {
      const r = vecResults[i];
      const rrfScore = 1 / (RRF_K + i + 1);
      const existing = scores.get(r.id);
      if (existing) {
        existing.score += rrfScore;
        // Keep the richer snippet
        if (r.snippet.length > existing.result.snippet.length) {
          existing.result.snippet = r.snippet;
        }
      } else {
        scores.set(r.id, { result: r, score: rrfScore });
      }
    }

    // Apply recency boost: entries from context/archive with timestamps
    const now = Date.now() / 1000; // Unix seconds
    for (const entry of scores.values()) {
      const recency = this.getRecencyBoost(entry.result.updated_at, now);
      entry.score *= recency;
    }

    // Sort by combined RRF score * recency
    return Array.from(scores.values())
      .sort((a, b) => b.score - a.score)
      .map(({ result, score }) => ({ ...result, score }));
  }

  /**
   * Recency boost factor: newer entries get slightly higher scores.
   * Returns 1.0..1.5 — a 50% max boost for very recent entries.
   * Pure — updated_at must be populated by the caller (FTS/vec SELECTs
   * already return it, no extra DB round-trips here).
   */
  private getRecencyBoost(
    updatedAt: number | undefined,
    nowSec: number,
  ): number {
    if (!updatedAt) return 1.0;

    const ageHours = (nowSec - updatedAt) / 3600;

    // Decay: 1.5 for < 1h, 1.3 for < 24h, 1.1 for < 7d, 1.0 for older
    if (ageHours < 1) return 1.5;
    if (ageHours < 24) return 1.3;
    if (ageHours < 168) return 1.1;
    return 1.0;
  }

  // ─── Rerank ────────────────────────────────────────────

  private async rerank(
    query: string,
    candidates: RAGResult[],
    topN: number,
  ): Promise<RAGResult[]> {
    const passages = candidates.map((c) => c.snippet || c.title);

    const result = await this.router.scheduleRaw("normal", () =>
      this.router.raw.rerank({
        model: RERANK_MODEL,
        query,
        passages: passages.map((text) => ({ text })),
        top_n: topN,
      }),
    );

    return result.results
      .sort((a, b) => b.relevance_score - a.relevance_score)
      .map((r) => ({
        ...candidates[r.index],
        score: r.relevance_score,
      }));
  }

  // ─── Embedding Cache ────────────────────────────────────

  /**
   * Embed a query string, using LRU cache to save RPM.
   * Normalizes key to lowercase trimmed. TTL = 5 min.
   */
  private async embedQuery(query: string): Promise<Float32Array> {
    const key = query.toLowerCase().trim();
    const now = Date.now();

    // Check cache
    const cached = this.embedCache.get(key);
    if (cached && now - cached.ts < EMBED_CACHE_TTL) {
      return cached.vec;
    }

    // Call provider
    const embedResult = await this.router.scheduleRaw("normal", () =>
      this.router.raw.embed({
        model: EMBED_MODEL,
        input: [query],
        input_type: "query",
      }),
    );

    const vec = new Float32Array(embedResult.data[0].embedding);

    // Evict oldest if over capacity
    if (this.embedCache.size >= EMBED_CACHE_MAX) {
      let oldestKey = "";
      let oldestTs = Infinity;
      for (const [k, v] of this.embedCache) {
        if (v.ts < oldestTs) {
          oldestTs = v.ts;
          oldestKey = k;
        }
      }
      if (oldestKey) this.embedCache.delete(oldestKey);
    }

    this.embedCache.set(key, { vec, ts: now });
    return vec;
  }

  /** Cache stats for observability */
  get cacheStats() {
    return { size: this.embedCache.size, maxSize: EMBED_CACHE_MAX };
  }

  // ─── Helpers ───────────────────────────────────────────

  /**
   * Embed a piece of content via the embedding provider. Throws on failure —
   * callers decide whether to swallow or propagate (night-cycle wants atomicity).
   */
  async embedContent(content: string): Promise<Float32Array> {
    const embedResult = await this.router.scheduleRaw("low", () =>
      this.router.raw.embed({
        model: EMBED_MODEL,
        input: [content],
        input_type: "passage",
      }),
    );
    return new Float32Array(embedResult.data[0].embedding);
  }

  /**
   * Embed and store a memory entry's content.
   * Call this after memory_write to keep vec index in sync.
   */
  async indexEntry(id: string, layer: string, content: string): Promise<void> {
    const vec = await this.embedContent(content);
    this.memory.upsertEmbedding(id, layer, vec);
  }
}
