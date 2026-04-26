/**
 * M-05 (mig 14): post-insert hook that draws `relates` edges to the top-3
 * vec neighbours in the same layer. Cap configurable via LINK_RELATED_TOP_N.
 * Non-blocking — RAG failure logs at warn and returns silently so the
 * calling write keeps its OK status.
 *
 * Self-skip: never link an inserted row to itself even if RAG surfaces it
 * (vector index is updated transactionally before this runs in some
 * call paths).
 */
import type { MemoryDB } from "../../../db";
import type { RAGPipeline } from "../../../rag";
import type { RequestLogger } from "../../../lib/logger";

export const LINK_RELATED_TOP_N = 3;

export async function linkRelated(
  memory: MemoryDB,
  rag: RAGPipeline,
  insertedId: string,
  layer: "context" | "shared",
  content: string,
  log: RequestLogger,
): Promise<void> {
  try {
    const neighbours = await rag.search({
      query: content,
      layers: [layer],
      rerankTopN: LINK_RELATED_TOP_N,
      skipRerank: true,
    });
    let drawn = 0;
    for (const n of neighbours) {
      if (drawn >= LINK_RELATED_TOP_N) break;
      if (n.id === insertedId) continue;
      try {
        memory.linkEdge(insertedId, layer, n.id, n.layer, "relates", n.score ?? 1.0);
        drawn++;
      } catch (err) {
        const em = err instanceof Error ? err.message : String(err);
        log.warn("post.extractors", `linkRelated edge insert failed: ${em}`);
      }
    }
  } catch (err) {
    const em = err instanceof Error ? err.message : String(err);
    log.warn("post.extractors", `linkRelated failed for ${insertedId}: ${em}`);
  }
}
