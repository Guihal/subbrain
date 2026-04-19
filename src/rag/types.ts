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

// ─── Stop Words ──────────────────────────────────────────

// Common English/Russian stop words to strip from FTS5 queries
export const STOP_WORDS = new Set([
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
export function sanitizeFtsQuery(raw: string): string {
  const terms = raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ") // strip punctuation
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));

  if (terms.length === 0) return "";
  // FTS5 OR query for broader matching
  return terms.slice(0, 10).join(" OR ");
}
