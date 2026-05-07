import type { MemoryDB } from "@subbrain/core/db";
import { logger } from "@subbrain/core/lib/logger";
import type { ModelRouter } from "@subbrain/core/lib/model-router";
import type { RAGPipeline } from "../../../rag";
import {
  pruneCompletedTasks,
  pruneContext,
  pruneFocus,
  pruneShared,
  pruneStaleTasks,
} from "../prune";
import type { NightCycleResult } from "../types";
import { runStep } from "./run-step";

const log = logger.child("night.post");

export async function runPrunePhase(
  deps: {
    memory: MemoryDB;
    router: ModelRouter;
    rag: RAGPipeline;
  },
  result: NightCycleResult,
  signal?: AbortSignal,
): Promise<void> {
  const { memory, router, rag } = deps;

  // Resolve contradictions first (must complete before prune)
  await runStep(
    "Resolve contradictions",
    "Resolve",
    async () => {
      const { resolveContradictions } = await import("../steps");
      result.contradictionsResolved = await resolveContradictions(memory, router, rag);
    },
    result,
    signal,
  );

  // Independent I/O-heavy prune steps — fan out via Promise.allSettled
  const pruneSteps = [
    runStep(
      "Prune shared_memory",
      "Prune shared",
      async () => {
        result.sharedPruned = await pruneShared(memory, router);
        log.info(`shared pruned=${result.sharedPruned}`);
      },
      result,
      signal,
    ),
    runStep(
      "Prune layer2_context",
      "Prune context",
      async () => {
        result.contextPruned = await pruneContext(memory, router, rag);
        log.info(`context pruned=${result.contextPruned}`);
      },
      result,
      signal,
    ),
    runStep(
      "Prune layer1_focus",
      "Prune focus",
      async () => {
        result.focusPruned = await pruneFocus(memory, router);
        log.info(`focus pruned=${result.focusPruned}`);
      },
      result,
      signal,
    ),
  ];

  await Promise.allSettled(pruneSteps);

  // Stale-task DELETE pass runs BEFORE pruneCompletedTasks
  await runStep(
    "Prune stale tasks",
    "Prune stale tasks",
    async () => {
      const r = pruneStaleTasks(memory);
      result.staleOpenDeleted = r.openDeleted;
      result.staleInProgressDeleted = r.inProgressDeleted;
    },
    result,
    signal,
  );

  await runStep(
    "Prune completed tasks",
    "Prune tasks",
    async () => {
      result.tasksPruned = await pruneCompletedTasks(memory, rag);
      log.info(`tasks pruned=${result.tasksPruned}`);
    },
    result,
    signal,
  );
}
