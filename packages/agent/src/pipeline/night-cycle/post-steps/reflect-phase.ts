import { logger } from "@subbrain/core/lib/logger";
import type { MemoryDB } from "@subbrain/core/db";
import type { ModelRouter } from "@subbrain/core/lib/model-router";
import type { RAGPipeline } from "../../../rag";
import type { MemoryService } from "../../../services/memory";
import { collectStrayTasks } from "../prune";
import { runFocusRewrite, runReflect } from "../steps";
import type { NightCycleResult } from "../types";
import { runStep } from "./run-step";

const log = logger.child("night.post");

export async function runReflectPhase(
  deps: {
    memory: MemoryDB;
    router: ModelRouter;
    rag: RAGPipeline;
    memoryService?: MemoryService;
  },
  result: NightCycleResult,
  signal?: AbortSignal,
): Promise<void> {
  const { memory, router, rag, memoryService } = deps;

  // M-11: focus rewrite (shadow) — runs AFTER pruneFocus so dropped/merged
  // keys never reach the rewrite synthesis step
  await runStep(
    "Focus rewrite (shadow)",
    "Focus rewrite",
    async () => {
      const r = await runFocusRewrite({ memory, router });
      result.focusRewritten = r.rewritten;
      result.focusSkipped = r.skipped;
      result.focusErrors = r.errors;
      log.info(
        `focus-rewrite: rewritten=${r.rewritten} skipped=${r.skipped} errors=${r.errors}`,
      );
    },
    result,
    signal,
  );

  // Collect stray tasks (advisory cleanup)
  await runStep(
    "Collect stray tasks",
    "Collect strays",
    async () => {
      result.straysCollected = await collectStrayTasks(memory, router);
      log.info(`strays migrated=${result.straysCollected}`);
    },
    result,
    signal,
  );

  // M-06: CoALA reflect — runs AFTER dedup + decay + cross-layer so it sees
  // the cleaned, decayed, cross-layer-merged substrate
  if (memoryService) {
    await runStep(
      "Reflect (episodic→semantic)",
      "Reflect",
      async () => {
        const r = await runReflect({ memory, memoryService, rag, router });
        result.reflectGroupsExamined = r.groups_examined;
        result.reflectFactsPromoted = r.facts_promoted;
        result.reflectEdgesCreated = r.edges_created;
        result.reflectLLMFailures = r.llm_failures;
        log.info(
          `reflect: groups=${r.groups_examined} promoted=${r.facts_promoted} edges=${r.edges_created} failures=${r.llm_failures}`,
        );
      },
      result,
      signal,
    );
  }
}
