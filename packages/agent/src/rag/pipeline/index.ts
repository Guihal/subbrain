import type { MemoryDB } from "@subbrain/core/db";
import { applyForgettingCurve } from "@subbrain/core/lib/memory-decay";
import type { ModelRouter } from "@subbrain/core/lib/model-router";
import type { RAGResult, RAGSearchOptions } from "../types";
import { applyEdgeWalkBoost, bumpAccessAsync, SALIENCE_BOOST_FACTOR } from "./boosts";
import { EmbedCache, embedBatch, embedContent } from "./embed";
import { ftsSearch } from "./fts";
import { rerank } from "./rerank";
import { dedupeById, rrfMerge } from "./rrf";
import { vecSearch } from "./vec";

export type { RAGResult, RAGSearchOptions } from "../types";

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

export class RAGPipeline {
  private embedCache = new EmbedCache();

  constructor(
    private memory: MemoryDB,
    private router: ModelRouter,
  ) {}

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

    const ftsResults = ftsSearch(this.memory, query, layers, ftsLimit, agentId, sessionId);

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

    const merged = rrfMerge(dedupeById(ftsResults), dedupeById(vecResults));

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

    // P3-4: edge-walk boost composes non-stacking with persona/salience
    // via Math.max inside applyEdgeWalkBoost. Then forgetting curve.
    final = applyEdgeWalkBoost(final, this.memory);
    const nowSec = Math.floor(Date.now() / 1000);
    final = applyForgettingCurve(
      final,
      nowSec,
      { recall: recallWeight(), salience: salienceWeight() },
      { skipPersona: true },
    );
    final.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

    bumpAccessAsync(this.memory, final);

    return final;
  }

  get cacheStats() {
    return this.embedCache.stats;
  }

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

  embedContent(content: string, signal?: AbortSignal): Promise<Float32Array> {
    return embedContent(this.router, content, signal);
  }

  embedBatch(inputs: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    return embedBatch(this.router, inputs, signal);
  }

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
