import type { MemoryDB, FtsResult, VecResult } from "../db";
import type { ModelRouter } from "../lib/model-router";

const RRF_K = 60; // Reciprocal Rank Fusion constant
const EMBED_CACHE_MAX = 64; // Max cached query embeddings
const EMBED_CACHE_TTL = 5 * 60_000; // 5 min TTL

// Common English/Russian stop words to strip from FTS5 queries
const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "can",
  "shall",
  "to",
  "of",
  "in",
  "for",
  "on",
  "with",
  "at",
  "by",
  "from",
  "as",
  "into",
  "about",
  "like",
  "through",
  "after",
  "over",
  "between",
  "out",
  "against",
  "during",
  "without",
  "before",
  "under",
  "around",
  "among",
  "that",
  "this",
  "these",
  "those",
  "it",
  "its",
  "i",
  "me",
  "my",
  "we",
  "our",
  "you",
  "your",
  "he",
  "she",
  "they",
  "them",
  "their",
  "what",
  "which",
  "who",
  "whom",
  "why",
  "how",
  "when",
  "where",
  "if",
  "then",
  "so",
  "but",
  "and",
  "or",
  "not",
  "no",
  "nor",
  "all",
  "each",
  "every",
  "both",
  "few",
  "more",
  "most",
  "some",
  "any",
  "other",
  "и",
  "в",
  "на",
  "с",
  "по",
  "для",
  "из",
  "к",
  "о",
  "у",
  "за",
  "от",
  "до",
  "при",
  "не",
  "что",
  "как",
  "это",
  "мы",
  "он",
  "она",
  "они",
  "его",
  "её",
  "их",
  "наш",
  "ваш",
  "мой",
  "свой",
  "все",
  "так",
  "но",
  "да",
  "же",
  "ли",
  "бы",
  "ещё",
  "уже",
  "или",
  "ни",
]);

/**
 * Sanitize a natural language string for FTS5 MATCH:
 * - Strip stop words
 * - Use OR between remaining terms for broader matching
 * - Escape special FTS5 characters
 */
function sanitizeFtsQuery(raw: string): string {
  const terms = raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ") // strip punctuation
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));

  if (terms.length === 0) return "";
  // FTS5 OR query for broader matching
  return terms.slice(0, 10).join(" OR ");
}

export interface RAGResult {
  id: string;
  layer: string;
  title: string;
  snippet: string;
  score: number;
  created_at?: number;
  updated_at?: number;
}

export interface RAGSearchOptions {
  query: string;
  layers?: ("context" | "archive" | "shared")[];
  ftsLimit?: number;
  vecLimit?: number;
  rerankTopN?: number;
  skipRerank?: boolean;
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

    // 3. RRF Merge
    const merged = this.rrfMerge(ftsResults, vecResults);

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

    if (layers.includes("context")) {
      for (const r of this.memory.searchContext(ftsQuery, limit)) {
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
      for (const r of this.memory.searchShared(ftsQuery, limit)) {
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
      for (const vr of vecResults) {
        // Fetch full content for snippet
        const entry = this.fetchEntry(vr.id, vr.layer);
        results.push({
          id: vr.id,
          layer: vr.layer,
          title: entry?.title || vr.id,
          snippet: entry?.snippet || "",
          score: 1 / (1 + vr.distance), // Convert distance to similarity score
          created_at: entry?.created_at,
          updated_at: entry?.updated_at,
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
      const recency = this.getRecencyBoost(
        entry.result.id,
        entry.result.layer,
        now,
      );
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
   */
  private getRecencyBoost(id: string, layer: string, nowSec: number): number {
    let updatedAt: number | undefined;

    if (layer === "context") {
      const row = this.memory.getContext(id);
      updatedAt = row?.updated_at;
    } else if (layer === "archive") {
      const row = this.memory.getArchive(id);
      updatedAt = row?.updated_at;
    }

    if (!updatedAt) return 1.0;

    const ageSec = nowSec - updatedAt;
    const ageHours = ageSec / 3600;

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
        model: "nvidia/rerank-qa-mistral-4b",
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
        model: "nvidia/llama-3.2-nemoretriever-300m-embed-v1",
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

  private fetchEntry(
    id: string,
    layer: string,
  ): {
    title: string;
    snippet: string;
    created_at?: number;
    updated_at?: number;
  } | null {
    if (layer === "context") {
      const row = this.memory.getContext(id);
      return row
        ? {
            title: row.title,
            snippet: row.content.substring(0, 300),
            created_at: row.created_at,
            updated_at: row.updated_at,
          }
        : null;
    }
    if (layer === "archive") {
      const row = this.memory.getArchive(id);
      return row
        ? {
            title: row.title,
            snippet: row.content.substring(0, 300),
            created_at: row.created_at,
            updated_at: row.updated_at,
          }
        : null;
    }
    return null;
  }

  /**
   * Embed and store a memory entry's content.
   * Call this after memory_write to keep vec index in sync.
   */
  async indexEntry(id: string, layer: string, content: string): Promise<void> {
    const embedResult = await this.router.scheduleRaw("low", () =>
      this.router.raw.embed({
        model: "nvidia/llama-3.2-nemoretriever-300m-embed-v1",
        input: [content],
        input_type: "passage",
      }),
    );

    const vec = new Float32Array(embedResult.data[0].embedding);
    this.memory.upsertEmbedding(id, layer, vec);
  }
}
