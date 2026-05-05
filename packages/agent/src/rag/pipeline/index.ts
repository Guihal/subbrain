import type { MemoryDB } from "@subbrain/core/db";
import { applyForgettingCurve } from "@subbrain/core/lib/memory-decay";
import type { ModelRouter } from "@subbrain/core/lib/model-router";
import type { RAGResult, RAGSearchOptions } from "../types";
import {
  applyPersonaBoost,
  applySalienceBoost,
  bumpAccessAsync,
  SALIENCE_BOOST_FACTOR,
} from "./boosts";
import { EmbedCache, embedBatch, embedContent } from "./embed";
import { ftsSearch } from "./fts";
import { rerank } from "./rerank";
import { dedupeById, rrfMerge } from "./rrf";
import { vecSearch } from "./vec";

export type { RAGResult, RAGSearchOptions } from "../types";

// M-08: env knobs for the forgetting-curve recall multiplier. Read at
// call-time so tests toggle per-case without a subprocess. `RAG_RECALL_WEIGHT=0`
// disables the effect entirely (multiplier collapses to 1.0).
function recallWeight(): number {
  const raw = process.env.RAG_RECALL_WEIGHT;
  if (raw === undefined || raw === "") return 0.15;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0.15;
}
function salienceWeight(): number {
  const raw = process.env.RAG_SALIENCE_WEIGHT;
  if (raw === undefined || raw === "") return SALIENCE_BOOST_FACTOR;
  const n = Number(raw);
  return Number.isFinite(n) ? n : SALIENCE_BOOST_FACTOR;
}

/**
 * Hybrid RAG pipeline: FTS5 + Vector search → RRF merge → Rerank.
 * Consumes 1-2 RPM per search (embed + optional rerank). Includes LRU
 * embedding cache to reduce RPM usage.
 */
export class RAGPipeline {
  private embedCache = new EmbedCache();

  constructor(
    private memory: MemoryDB,
    private router: ModelRouter,
  ) {}

  /** Full hybrid search: FTS5 + vector → RRF → rerank. */
  async search(opts: RAGSearchOptions): Promise<RAGResult[]> {
    const {
      query,
      layers = ["context", "archive", "shared"],
      ftsLimit = 20,
      vecLimit = 20,
      rerankTopN = 5,
      skipRerank = false,
      agentId,
      sessionId,
    } = opts;

    // 1. FTS5 search (local, no RPM cost).
    const ftsResults = ftsSearch(this.memory, query, layers, ftsLimit, agentId, sessionId);

    // 2. Vector search (1 RPM for embed) — graceful degradation. M-04.1:
    // `"log"` is a first-class vec layer (rolling N=10k window kept by the
    // night-cycle `embed-log` step). Default `layers` excludes log
    // (privacy: raw log holds pre-scrub PII), so log vec only runs when
    // callers explicitly opt in.
    let vecResults: RAGResult[] = [];
    try {
      if (layers.length > 0) {
        vecResults = await vecSearch(
          this.memory,
          (q) => this.embedCache.query(this.router, q),
          query,
          layers,
          vecLimit,
          agentId,
        );
      }
    } catch {
      // Vector search unavailable — continue with FTS-only.
    }

    // 3. RRF Merge (dedup each source — FTS and vec can emit same id twice
    // across layers; rrfMerge expects first-seen rank).
    const merged = rrfMerge(dedupeById(ftsResults), dedupeById(vecResults));

    // 4. Rerank top candidates (1 RPM) — graceful degradation.
    let final: RAGResult[];
    if (skipRerank || merged.length <= 1) {
      final = merged.slice(0, rerankTopN);
    } else {
      try {
        final = await rerank(this.router, query, merged, rerankTopN);
      } catch {
        final = merged.slice(0, rerankTopN);
      }
    }

    // M-07: persona boost (+10% for kind === 'persona' shared rows). M-03:
    // salience boost (+10% × salience). M-08: MemoryBank-style forgetting
    // curve (recall multiplier). Applied in this order so the final sort
    // reflects all signals — persona > salience > recall.
    final = applyPersonaBoost(final);
    final = applySalienceBoost(final);
    const nowSec = Math.floor(Date.now() / 1000);
    final = applyForgettingCurve(
      final,
      nowSec,
      { recall: recallWeight(), salience: salienceWeight() },
      { skipPersona: true },
    );
    final.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

    // 5. M-02: bump access counters for surviving rows. Non-blocking
    // fire-and-forget; `Promise.allSettled` per layer.
    bumpAccessAsync(this.memory, final);

    return final;
  }

  /** Cache stats for observability. */
  get cacheStats() {
    return this.embedCache.stats;
  }

  // ─── FTS / vec public methods (consumed by tests + agent-loop helpers) ───

  ftsSearch(
    query: string,
    layers: string[],
    limit: number,
    agentId?: string,
    sessionId?: string,
  ): RAGResult[] {
    return ftsSearch(this.memory, query, layers, limit, agentId, sessionId);
  }

  vecSearch(
    query: string,
    layers: string[],
    limit: number,
    agentId?: string,
  ): Promise<RAGResult[]> {
    return vecSearch(
      this.memory,
      (q) => this.embedCache.query(this.router, q),
      query,
      layers,
      limit,
      agentId,
    );
  }

  // ─── Public helpers (consumed by services / scripts) ─────────

  embedContent(content: string, signal?: AbortSignal): Promise<Float32Array> {
    return embedContent(this.router, content, signal);
  }

  embedBatch(inputs: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    return embedBatch(this.router, inputs, signal);
  }

  /**
   * Embed and store a memory entry's content. Call this after memory_write
   * to keep vec index in sync.
   */
  async indexEntry(
    id: string,
    layer: string,
    content: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const vec = await this.embedContent(content, signal);
    this.memory.upsertEmbedding(id, layer, vec);
  }
}
