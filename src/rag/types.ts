// ─── Re-export shared FTS utils ──────────────────────────

export { sanitizeFtsQuery } from "../lib/fts-utils";

// ─── Constants ───────────────────────────────────────────

export const RRF_K = 60; // Reciprocal Rank Fusion constant
export const EMBED_CACHE_MAX = 64; // Max cached query embeddings
export const EMBED_CACHE_TTL = 5 * 60_000; // 5 min TTL

// ─── Types ───────────────────────────────────────────────

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
