import type { ModelRouter } from "../../lib/model-router";
import { EMBED_MODEL } from "../../lib/model-map";
import { EMBED_CACHE_MAX, EMBED_CACHE_TTL } from "../types";

export class EmbedCache {
  private cache = new Map<string, { vec: Float32Array; ts: number }>();

  /** Embed a query with LRU+TTL cache. Normalizes key to lowercase trimmed. */
  async query(
    router: ModelRouter,
    query: string,
    signal?: AbortSignal,
  ): Promise<Float32Array> {
    const key = query.toLowerCase().trim();
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached && now - cached.ts < EMBED_CACHE_TTL) return cached.vec;

    const embedResult = await router.scheduleRaw("normal", () =>
      router.raw.embed({
        model: EMBED_MODEL,
        input: [query],
        input_type: "query",
        signal,
      }),
    );
    const vec = new Float32Array(embedResult.data[0].embedding);

    // Evict oldest if over capacity.
    if (this.cache.size >= EMBED_CACHE_MAX) {
      let oldestKey = "";
      let oldestTs = Infinity;
      for (const [k, v] of this.cache) {
        if (v.ts < oldestTs) { oldestTs = v.ts; oldestKey = k; }
      }
      if (oldestKey) this.cache.delete(oldestKey);
    }
    this.cache.set(key, { vec, ts: now });
    return vec;
  }

  get stats() {
    return { size: this.cache.size, maxSize: EMBED_CACHE_MAX };
  }
}

/**
 * Embed a piece of content via the embedding provider. Throws on failure —
 * callers decide whether to swallow or propagate (night-cycle wants
 * atomicity). H-1: optional `signal` propagates into the upstream HTTP call.
 */
export async function embedContent(
  router: ModelRouter,
  content: string,
  signal?: AbortSignal,
): Promise<Float32Array> {
  const embedResult = await router.scheduleRaw("low", () =>
    router.raw.embed({
      model: EMBED_MODEL,
      input: [content],
      input_type: "passage",
      signal,
    }),
  );
  return new Float32Array(embedResult.data[0].embedding);
}

/**
 * M-04.1: batch embed for the night-cycle `embed-log` step. Single upstream
 * call, one rate-limit slot. Caller is responsible for chunking the input
 * list (NVIDIA limits per request); this helper does not split. Returns
 * vectors in same order as `inputs`.
 */
export async function embedBatch(
  router: ModelRouter,
  inputs: string[],
  signal?: AbortSignal,
): Promise<Float32Array[]> {
  if (inputs.length === 0) return [];
  const embedResult = await router.scheduleRaw("low", () =>
    router.raw.embed({
      model: EMBED_MODEL,
      input: inputs,
      input_type: "passage",
      signal,
    }),
  );
  return embedResult.data.map((d) => new Float32Array(d.embedding));
}
