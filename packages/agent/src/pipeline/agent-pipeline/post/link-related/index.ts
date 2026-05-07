/** M-05/M-05.1/M-05.2: post-insert edge hook. See docs/completed/05-rag-pipeline.md. */
import type { MemoryDB } from "@subbrain/core/db";
import type { EdgeKind } from "@subbrain/core/db/types";
import type { RequestLogger } from "@subbrain/core/lib/logger";
import type { ModelRouter } from "@subbrain/core/lib/model-router";
import type { RAGPipeline } from "../../../../rag";
import {
  detectContradictions,
  detectEnabled,
  minConf,
  type ContradictionCandidate,
} from "./contradict";
import { evolveEnabled, evolveNeighbour, maxTags } from "./evolve";

export { parseTagsCsv } from "./evolve";
export type { ContradictionCandidate, ContradictionVerdict } from "./contradict";

export const LINK_RELATED_TOP_N = 3;

const RELATES_KIND: EdgeKind = "relates";
const CONTRADICTS_KIND: EdgeKind = "contradicts";

function drawRelatesEdge(
  memory: MemoryDB,
  insertedId: string,
  layer: "context" | "shared",
  neighbour: { id: string; layer: "context" | "shared" },
  log: RequestLogger,
): boolean {
  try {
    memory.linkEdge(insertedId, layer, neighbour.id, neighbour.layer, RELATES_KIND, 1.0);
    return true;
  } catch (err) {
    log.warn(
      "post.extractors",
      `linkRelated edge insert failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

export async function linkRelated(
  memory: MemoryDB,
  rag: RAGPipeline,
  router: ModelRouter,
  insertedId: string,
  layer: "context" | "shared",
  content: string,
  insertedTags: string[],
  log: RequestLogger,
  signal?: AbortSignal,
): Promise<void> {
  const drawnNeighbours: { id: string; layer: "context" | "shared" }[] = [];

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
      if (n.layer !== "context" && n.layer !== "shared") continue;
      const neighbour = n as { id: string; layer: "context" | "shared" };
      if (drawRelatesEdge(memory, insertedId, layer, neighbour, log)) {
        drawn++;
        drawnNeighbours.push(neighbour);
      }
      if (insertedTags.length > 0 && evolveEnabled()) {
        try {
          evolveNeighbour(memory, neighbour.id, neighbour.layer, insertedTags, maxTags());
        } catch (err) {
          log.warn(
            "post.extractors",
            `evolveNeighbour failed for ${neighbour.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  } catch (err) {
    log.warn(
      "post.extractors",
      `linkRelated failed for ${insertedId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // M-05.2: contradiction detection (default off; one LLM call vs drawnNeighbours).
  if (!detectEnabled() || drawnNeighbours.length === 0) return;
  try {
    const candidates: ContradictionCandidate[] = [];
    for (const n of drawnNeighbours) {
      const row = n.layer === "context" ? memory.getContext(n.id) : memory.getShared(n.id);
      if (!row) continue; // deleted mid-flight.
      candidates.push({ id: n.id, layer: n.layer, content: row.content });
    }
    if (candidates.length === 0) return;
    const verdicts = await detectContradictions(router, log, content, candidates, signal);
    const threshold = minConf();
    for (const v of verdicts) {
      if (v.confidence < threshold) continue;
      const cand = candidates.find((c) => c.id === v.id);
      if (!cand) continue; // hallucinated id.
      try {
        memory.linkEdge(insertedId, layer, cand.id, cand.layer, CONTRADICTS_KIND, v.confidence);
      } catch (err) {
        log.warn(
          "post.extractors",
          `contradiction edge insert failed for ${cand.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } catch (err) {
    log.warn(
      "post.extractors",
      `detectContradictions failed for ${insertedId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
