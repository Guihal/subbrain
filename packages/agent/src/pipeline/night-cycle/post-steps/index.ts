/**
 * Post-batch maintenance steps orchestrator.
 * Phases run in strict order; independent steps within a phase use
 * Promise.allSettled. Each step is wrapped in try/catch so one failure
 * never aborts the cycle.
 */
import type { MemoryDB } from "@subbrain/core/db";
import type { ModelRouter } from "@subbrain/core/lib/model-router";
import type { RAGPipeline } from "../../../rag";
import type { MemoryService } from "../../../services/memory";
import type { Notifier } from "../../../telegram/bot/notify";
import type { NightCycleResult } from "../types";
import { runDedupPhase } from "./dedup-phase";
import { runJanitorPhase } from "./janitor-phase";
import { runPrunePhase } from "./prune-phase";
import { runReflectPhase } from "./reflect-phase";

export async function runPostBatchSteps(
  deps: {
    memory: MemoryDB;
    router: ModelRouter;
    rag: RAGPipeline;
    memoryService?: MemoryService;
    notifier?: Notifier;
  },
  result: NightCycleResult,
  signal?: AbortSignal,
): Promise<void> {
  await runPrunePhase(deps, result, signal);
  await runReflectPhase(deps, result, signal);
  await runDedupPhase(deps, result, signal);
  await runJanitorPhase(deps, result, signal);
}
