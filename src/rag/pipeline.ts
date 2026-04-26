import type { MemoryDB, FtsResult, VecResult } from "../db";
import type { ModelRouter } from "../lib/model-router";
import { EMBED_MODEL, RERANK_MODEL } from "../lib/model-map";
import { logger } from "../lib/logger";
import {
  RRF_K,
  EMBED_CACHE_MAX,
  EMBED_CACHE_TTL,
  sanitizeFtsQuery,
  type RAGResult,
  type RAGSearchOptions,
} from "./types";
import { applyForgettingCurve } from "../lib/memory-decay";

export type { RAGResult, RAGSearchOptions } from "./types";

const log = logger.child("rag");

// M-02: env flag — `RAG_BUMP_ACCESS=false` disables the post-rerank access
// bump entirely. Default on. Read at call-time (not module load) so test
// suites can toggle the flag per case without spawning a subprocess.
function bumpAccessEnabled(): boolean {
  return process.env.RAG_BUMP_ACCESS !== "false";
}

// M-02 (mig 10): the three layers we know how to bump. `RAGResult.layer` is
// a free string upstream, so this filter both narrows the type and silently
// skips any future synthetic layer (e.g. a "tasks" layer M-04 might add).
type BumpLayer = "shared" | "context" | "archive";
function isBumpLayer(l: string): l is BumpLayer {
  return l === "shared" || l === "context" || l === "archive";
}

// M-07 (mig 12): persona-grade shared rows get a +10% rerank score boost.
// 1.1× is intentionally moderate — anything bigger drowns out semantic facts
// that are also relevant to the query. M-08 will A/B-tune this constant
// against the new salience signal.
const PERSONA_BOOST = 1.1;

// M-03 (mig 13): salience signal blends multiplicatively with the rerank
// score. A row at salience=1.0 gets a +10% bump (1 + 0.1 * 1); salience=0.0
// gets nothing; default 0.5 gets +5%. Stacks with persona boost so a
// persona row at high salience sees ~1.21× combined — the cosine signal
// still dominates ranking. Tunable; M-08 A/B may revise.
const SALIENCE_BOOST_FACTOR = 0.1;

// M-08: env knobs for the forgetting-curve recall multiplier. Read at
// call-time (not module load) so test suites can toggle per-case without
// a subprocess. `RAG_RECALL_WEIGHT=0` disables the effect entirely (the
// multiplier collapses to 1.0). `RAG_SALIENCE_WEIGHT` is documented here
// for parity even though the salience-boost itself still lives in
// `applySalienceBoost` — the constant `SALIENCE_BOOST_FACTOR` above is
// the actual source of truth for the salience multiplier.
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

function dedupeById(results: RAGResult[]): RAGResult[] {
  // M-04: dedupe key is `${layer}:${id}` — log layer ids are stringified
  // integers ("42") while shared/context/archive use uuids; an unguarded
  // id-only key would silently drop one if a future layer emitted numeric
  // ids that happened to collide with an existing uuid prefix.
  const seen = new Map<string, RAGResult>();
  for (const r of results) {
    const key = `${r.layer}:${r.id}`;
    if (!seen.has(key)) seen.set(key, r);
  }
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
      agentId,
      sessionId,
    } = opts;

    // 1. FTS5 search (local, no RPM cost)
    const ftsResults = this.ftsSearch(query, layers, ftsLimit, agentId, sessionId);

    // 2. Vector search (1 RPM for embed) — graceful degradation. M-04:
    // skip vec for the "log" layer (no embeddings on Layer 4 in this PR);
    // pass through the embeddable subset only.
    const vecLayers = layers.filter((l) => l !== "log");
    let vecResults: RAGResult[] = [];
    try {
      if (vecLayers.length > 0) {
        vecResults = await this.vecSearch(query, vecLayers, vecLimit, agentId);
      }
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
    let final: RAGResult[];
    if (skipRerank || merged.length <= 1) {
      final = merged.slice(0, rerankTopN);
    } else {
      try {
        final = await this.rerank(query, merged, rerankTopN);
      } catch {
        final = merged.slice(0, rerankTopN);
      }
    }

    // M-07: +10% rerank boost for `kind === 'persona'` shared rows. Applied
    // after rerank so it covers both the Cohere path and the skipRerank /
    // rerank-fail fallbacks. Re-sorts in place.
    final = this.applyPersonaBoost(final);

    // M-03 (mig 13): salience boost stacks multiplicatively on top of the
    // persona boost. Persona signal answers "what KIND of fact is this?"
    // (identity vs. semantic); salience answers "how often is THIS row
    // referenced?". Applied after persona so the resulting order reflects
    // both signals — a hot persona row outranks a cold persona row.
    final = this.applySalienceBoost(final);

    // M-08: MemoryBank-style forgetting curve. Multiplies score by
    // (1 + W_RECALL * R) where R = exp(-Δt / S). Persona rows pass through
    // unchanged (skipPersona=true) — identity facts must never decay.
    // Re-sort here so this layer's signal is reflected in the final order.
    // RAG_RECALL_WEIGHT=0 collapses the multiplier to 1.0 (effect disabled).
    const nowSec = Math.floor(Date.now() / 1000);
    final = applyForgettingCurve(
      final,
      nowSec,
      { recall: recallWeight(), salience: salienceWeight() },
      { skipPersona: true },
    );
    final.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

    // 5. M-02 (mig 10): bump access counters for surviving rows. Non-
    // blocking — fire-and-forget so retrieval latency is not paid for the
    // UPDATE. `Promise.allSettled` per layer (never `Promise.all`) so a
    // single layer's failure does not poison the others. Errors are
    // logged via `log.warn` and otherwise swallowed — access tracking is
    // a side-signal, never a retrieval-blocker.
    this.bumpAccessAsync(final);

    return final;
  }

  /**
   * M-07 (mig 12): boost persona-grade shared rows by `PERSONA_BOOST` (1.1×).
   * Pure mutation of the score field + re-sort by descending score. Non-
   * persona rows pass through unchanged. Shared-only — context/archive
   * results have `kind === undefined` and skip the multiplier branch.
   *
   * Why post-rerank: Cohere reranker doesn't see our persona signal, so
   * the bump is applied AFTER its `relevance_score` lands. For skipRerank
   * and rerank-failure paths, the same step still fires and ranks persona
   * facts above semantic ones with the same RRF score.
   */
  private applyPersonaBoost(results: RAGResult[]): RAGResult[] {
    if (results.length === 0) return results;
    const boosted = results.map((r) =>
      r.layer === "shared" && r.kind === "persona"
        ? { ...r, score: r.score * PERSONA_BOOST }
        : r,
    );
    boosted.sort((a, b) => b.score - a.score);
    return boosted;
  }

  /**
   * M-03 (mig 13): salience-based boost. Multiplies score by
   * `1 + 0.1 * salience` so hot rows (salience → 1.0) get up to +10% on top
   * of whatever ranking they already have. Default salience for log layer
   * (no column) or pre-mig-13 rows is 0.5 — a neutral +5%. Stacks
   * multiplicatively with persona boost; combined max ≈ 1.21×.
   *
   * Applied after persona boost in `search()` so the re-sort here is the
   * final order. Pure function: returns a new array, original untouched.
   */
  private applySalienceBoost(results: RAGResult[]): RAGResult[] {
    if (results.length === 0) return results;
    const boosted = results.map((r) => {
      const salience = r.salience ?? 0.5;
      return { ...r, score: r.score * (1 + SALIENCE_BOOST_FACTOR * salience) };
    });
    boosted.sort((a, b) => b.score - a.score);
    return boosted;
  }

  /**
   * M-02: schedule a non-blocking access bump for the supplied results.
   * Groups by layer (Map<layer, ids[]>), one `bumpAccess` call per layer,
   * fan-out via `Promise.allSettled`. `void` + no `await` — caller does
   * not wait. Errors are warned and dropped.
   *
   * Disabled when env `RAG_BUMP_ACCESS=false` is set (early return).
   */
  private bumpAccessAsync(results: RAGResult[]): void {
    if (!bumpAccessEnabled()) return;
    if (results.length === 0) return;

    const byLayer = new Map<BumpLayer, string[]>();
    for (const r of results) {
      if (!isBumpLayer(r.layer)) continue;
      const arr = byLayer.get(r.layer);
      if (arr) arr.push(r.id);
      else byLayer.set(r.layer, [r.id]);
    }
    if (byLayer.size === 0) return;

    void Promise.allSettled(
      [...byLayer.entries()].map(([layer, ids]) =>
        Promise.resolve().then(() => this.memory.memoryRepo.bumpAccess(layer, ids)),
      ),
    ).then((settled) => {
      for (const s of settled) {
        if (s.status === "rejected") {
          const msg = s.reason instanceof Error ? s.reason.message : String(s.reason);
          log.warn(`bumpAccess failed: ${msg}`);
        }
      }
    });
  }

  /**
   * FTS5-only search (no RPM cost, fast).
   *
   * B-1: `agentId` (when set) restricts context hits to caller's private
   * rows + global (NULL) rows. Archive + shared ignore the filter (both
   * are by-design global; see searchShared comment in db/tables/shared.ts
   * and MEM-3 spec).
   *
   * M-04: `"log"` layer (when included) joins fts_log → layer4_log via
   * rowid. FTS-only (no vec branch — see `search`). `sessionId` filters
   * log rows by session; `agentId` filters by agent_id (NOT NULL on log
   * rows, so unlike context/archive/shared this is a hard equality match).
   */
  ftsSearch(
    query: string,
    layers: string[],
    limit: number,
    agentId?: string,
    sessionId?: string,
  ): RAGResult[] {
    const ftsQuery = sanitizeFtsQuery(query);
    if (!ftsQuery) return [];

    const results: RAGResult[] = [];

    // MEM-5 (PR 22a): RAG injection must see only approved ('active') facts;
    // pending / rejected rows are filtered at SQL level inside searchContext /
    // searchShared. Archive has no status column — unchanged.
    if (layers.includes("context")) {
      for (const r of this.memory.searchContext(ftsQuery, limit, { activeOnly: true, notStale: true, agentId })) {
        results.push({
          id: r.id,
          layer: "context",
          title: r.title,
          snippet: r.snippet,
          score: 0,
          created_at: r.created_at,
          updated_at: r.updated_at,
          // M-03: salience threaded through searchContext SELECT for
          // the post-rerank salience-boost step.
          salience: r.salience,
          // M-08: access columns threaded for the forgetting-curve step.
          last_accessed_at: r.last_accessed_at,
          access_count: r.access_count,
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
          // M-03: see context branch.
          salience: r.salience,
          // M-08: see context branch.
          last_accessed_at: r.last_accessed_at,
          access_count: r.access_count,
        });
      }
    }
    if (layers.includes("shared")) {
      for (const r of this.memory.searchShared(ftsQuery, limit, { activeOnly: true, notStale: true })) {
        results.push({
          id: r.id,
          layer: "shared",
          title: r.title,
          snippet: r.snippet,
          score: 0,
          created_at: r.created_at,
          updated_at: r.updated_at,
          // M-07: kind threaded through the SELECT in SharedTable.searchShared.
          kind: r.kind,
          // M-03: salience threaded through searchShared SELECT.
          salience: r.salience,
          // M-08: see context branch.
          last_accessed_at: r.last_accessed_at,
          access_count: r.access_count,
        });
      }
    }
    if (layers.includes("log")) {
      // Pass the already-sanitized `ftsQuery` (single source of truth,
      // matches the other layers above). searchLog re-sanitizes internally
      // — idempotent on the safe form, kept for direct callers.
      for (const r of this.memory.logRepo.searchLog(ftsQuery, { limit, agentId, sessionId })) {
        results.push({
          id: r.id,
          layer: "log",
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
   *
   * B-1: `agentId` filters context-layer hydration; archive + shared ignore.
   */
  async vecSearch(
    query: string,
    layers: string[],
    limit: number,
    agentId?: string,
  ): Promise<RAGResult[]> {
    // Embed the query (with cache)
    const queryVec = await this.embedQuery(query);
    const results: RAGResult[] = [];

    for (const layer of layers) {
      const vecResults = this.memory.searchEmbeddings(queryVec, limit, layer);
      if (vecResults.length === 0) continue;

      const ids = vecResults.map((v) => v.id);
      // One batch SELECT per layer, keyed by id.
      // M-07: `kind` is shared-only — non-shared layers leave it undefined.
      // M-03: `salience` is hydrated for all three layers (mig 13 columns).
      const byId = new Map<
        string,
        {
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
      >();
      // MEM-5 (PR 22a): vec search can return ids whose rows are pending /
      // rejected (the vec_embeddings table has no status column). activeOnly
      // drops them at hydrate time so they never enter RAG injection.
      if (layer === "context") {
        for (const r of this.memory.getContextMany(ids, { activeOnly: true, notStale: true, agentId })) {
          byId.set(r.id, {
            title: r.title,
            content: r.content,
            created_at: r.created_at,
            updated_at: r.updated_at,
            // M-03: SELECT * already returns salience.
            salience: r.salience,
            // M-08: SELECT * already returns access columns (M-02 mig 10).
            last_accessed_at: r.last_accessed_at,
            access_count: r.access_count,
          });
        }
      } else if (layer === "archive") {
        for (const r of this.memory.getArchiveMany(ids)) {
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
        for (const r of this.memory.getSharedMany(ids, { activeOnly: true, notStale: true })) {
          byId.set(r.id, {
            title: r.category,
            content: r.content,
            created_at: r.created_at,
            updated_at: r.updated_at,
            // M-07: persona boost reads this in applyPersonaBoost.
            kind: r.kind,
            // M-03: salience boost reads this in applySalienceBoost.
            salience: r.salience,
            // M-08: forgetting-curve reads these in applyForgettingCurve.
            last_accessed_at: r.last_accessed_at,
            access_count: r.access_count,
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
          kind: row?.kind,
          salience: row?.salience,
          // M-08: thread access columns into RAGResult for the
          // forgetting-curve step in `lib/memory-decay.ts`.
          last_accessed_at: row?.last_accessed_at,
          access_count: row?.access_count,
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
   * H-1: optional `signal` propagates into the upstream HTTP call.
   */
  private async embedQuery(
    query: string,
    signal?: AbortSignal,
  ): Promise<Float32Array> {
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
        signal,
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
   *
   * H-1: optional `signal` propagates into the upstream HTTP call so SSE
   * cancel / tool-timeout / request-abort actually stops the embed call
   * instead of running to completion (was the leak burning NVIDIA RPM).
   */
  async embedContent(content: string, signal?: AbortSignal): Promise<Float32Array> {
    const embedResult = await this.router.scheduleRaw("low", () =>
      this.router.raw.embed({
        model: EMBED_MODEL,
        input: [content],
        input_type: "passage",
        signal,
      }),
    );
    return new Float32Array(embedResult.data[0].embedding);
  }

  /**
   * Embed and store a memory entry's content.
   * Call this after memory_write to keep vec index in sync.
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
