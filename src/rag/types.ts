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
  // M-07 (mig 12): kind enum carried only for shared-layer hits. Powers the
  // persona-boost step in `rag/pipeline.ts` (RAGPipeline.applyPersonaBoost).
  // Optional because context/archive/log rows have no `kind` column.
  kind?: string;
  // M-03 (mig 13): salience score [0..1] carried for shared / context /
  // archive layers. Powers the salience-boost step in
  // `rag/pipeline.ts:applySalienceBoost`. Defaults to 0.5 in that step
  // when undefined (e.g. log layer or pre-mig-13 row), so callers don't
  // need to populate it. Stacks multiplicatively with persona boost.
  salience?: number;
}

// M-04: include "log" so the agent-only `memory_log_search` tool and
// hippocampus-style episodic queries can opt-in via `rag.search({...layers:["log"]})`.
// The default layers in `RAGPipeline.search` stay `["context","archive","shared"]`
// — "log" is opt-in only (privacy: raw log holds pre-scrub PII).
export type RAGLayer = "context" | "archive" | "shared" | "log";

export interface RAGSearchOptions {
  query: string;
  layers?: RAGLayer[];
  ftsLimit?: number;
  vecLimit?: number;
  rerankTopN?: number;
  skipRerank?: boolean;
  /**
   * B-1: restrict context-layer hits to caller's own private rows + global
   * (NULL) rows. Absent → no agent filter (admin / digest / report scope).
   * Archive + shared layers ignore this — both are by-design global.
   *
   * M-04: also filters the "log" layer to rows produced by this agent.
   */
  agentId?: string;
  /**
   * M-04: optionally restrict the `"log"` layer to a specific session_id.
   * Other layers ignore this. Used by per-session episodic recall (e.g.
   * "what did I say earlier in this conversation").
   */
  sessionId?: string;
}
