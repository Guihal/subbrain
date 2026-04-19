/**
 * FTS5 query sanitization utilities.
 * Single source of truth — used by both MemoryDB and RAG pipeline.
 */

/** Common English/Russian stop words to strip from FTS5 queries */
const STOP_WORDS = new Set([
  // English
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
  // Russian
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
 * Extract meaningful words from a raw query, stripping punctuation and stop words.
 * Returns empty array if no meaningful terms remain.
 */
function extractTerms(raw: string): string[] {
  return raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

/**
 * Sanitize a raw query for FTS5 MATCH.
 * Strips stop words, quotes each term, joins with OR.
 * Safe against FTS5 operator injection.
 *
 * @param raw - User-provided search query
 * @param maxTerms - Max terms to include (default: 10)
 * @returns FTS5-safe query string, or empty string if no terms
 */
export function sanitizeFtsQuery(raw: string, maxTerms = 10): string {
  const terms = extractTerms(raw);
  if (terms.length === 0) return "";
  return terms
    .slice(0, maxTerms)
    .map((t) => `"${t}"`)
    .join(" OR ");
}
