import { logger } from "@subbrain/core/lib/logger";
import type { MemoryDB } from "@subbrain/core/db";
import type { RAGPipeline } from "../../../rag";
import type { MemoryService } from "../../../services/memory";
import { decaySalience, runCrossLayerDedup, runMemoryDedup } from "../steps";
import type { NightCycleResult } from "../types";
import { runStep } from "./run-step";

const log = logger.child("night.post");

export async function runDedupPhase(
  deps: {
    memory: MemoryDB;
    rag: RAGPipeline;
    memoryService?: MemoryService;
  },
  result: NightCycleResult,
  signal?: AbortSignal,
): Promise<void> {
  const { memory, rag, memoryService } = deps;

  // MEM-6: cluster-merge near-duplicates + mark expired rows
  await runStep(
    "Memory dedup (cluster + expire)",
    "Memory dedup",
    async () => {
      const r = await runMemoryDedup(memory, rag);
      result.sharedDeduped = r.shared;
      result.contextDeduped = r.context;
      result.expiredMarked = r.expired;
      log.info(
        `memory-dedup: shared=${r.shared}, context=${r.context}, expired=${r.expired}`,
      );
    },
    result,
    signal,
  );

  // M-03: decay salience scores — read-then-multiply on already-cleaned set
  await runStep(
    "Decay salience",
    "Decay salience",
    async () => {
      const r = await decaySalience(memory);
      result.salienceDecayed = r.shared + r.context + r.archive;
      log.info(
        `decay-salience: shared=${r.shared}, context=${r.context}, archive=${r.archive}`,
      );
    },
    result,
    signal,
  );

  // M-09: cross-layer dedup + archive→shared promote
  if (memoryService) {
    await runStep(
      "Cross-layer dedup",
      "Cross-layer dedup",
      async () => {
        const r = await runCrossLayerDedup({ memory, memoryService });
        result.crossLayerPairsExamined = r.pairs_examined;
        result.crossLayerSupersedesAdded = r.supersedes_added;
        result.crossLayerPromotedToShared = r.promoted_to_shared;
        result.crossLayerErrors = r.errors;
        log.info(
          `cross-layer: pairs=${r.pairs_examined} supersedes=${r.supersedes_added} promoted=${r.promoted_to_shared} errors=${r.errors}`,
        );
      },
      result,
      signal,
    );
  }
}
