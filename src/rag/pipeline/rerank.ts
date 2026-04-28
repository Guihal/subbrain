import type { ModelRouter } from "../../lib/model-router";
import { RERANK_MODEL } from "../../lib/model-map";
import type { RAGResult } from "../types";

export async function rerank(
  router: ModelRouter,
  query: string,
  candidates: RAGResult[],
  topN: number,
): Promise<RAGResult[]> {
  const passages = candidates.map((c) => c.snippet || c.title);
  const result = await router.scheduleRaw("normal", () =>
    router.raw.rerank({
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
