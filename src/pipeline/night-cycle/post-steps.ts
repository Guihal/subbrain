/**
 * Post-batch maintenance steps (H-2 split): contradictions + prune* +
 * stray-task migration. Each step is wrapped in a try/catch that pushes
 * errors into `result.errors` so one failed step never aborts the cycle.
 */
import type { MemoryDB } from "@subbrain/core/db";
import { logger } from "@subbrain/core/lib/logger";
import type { ModelRouter } from "../../lib/model-router";
import type { RAGPipeline } from "../../rag";
import type { MemoryService } from "../../services/memory";
import type { Notifier } from "../../telegram/bot/notify";
import { runJanitor } from "./janitor";
import {
  collectStrayTasks,
  pruneCompletedTasks,
  pruneContext,
  pruneFocus,
  pruneShared,
  pruneStaleTasks,
} from "./prune";
import {
  decaySalience,
  resolveContradictions,
  runCrossLayerDedup,
  runEmbedLog,
  runFocusRewrite,
  runMemoryDedup,
  runReflect,
} from "./steps";
import type { NightCycleResult } from "./types";

const log = logger.child("night.post");

export async function runPostBatchSteps(
  deps: {
    memory: MemoryDB;
    router: ModelRouter;
    rag: RAGPipeline;
    memoryService?: MemoryService;
    notifier?: Notifier;
  },
  result: NightCycleResult,
): Promise<void> {
  const { memory, router, rag, memoryService, notifier } = deps;

  await runStep(
    "Resolve contradictions",
    "Resolve",
    async () => {
      result.contradictionsResolved = await resolveContradictions(memory, router, rag);
    },
    result,
  );

  await runStep(
    "Prune shared_memory",
    "Prune shared",
    async () => {
      result.sharedPruned = await pruneShared(memory, router);
      log.info(`shared pruned=${result.sharedPruned}`);
    },
    result,
  );

  await runStep(
    "Prune layer2_context",
    "Prune context",
    async () => {
      result.contextPruned = await pruneContext(memory, router, rag);
      log.info(`context pruned=${result.contextPruned}`);
    },
    result,
  );

  await runStep(
    "Prune layer1_focus",
    "Prune focus",
    async () => {
      result.focusPruned = await pruneFocus(memory, router);
      log.info(`focus pruned=${result.focusPruned}`);
    },
    result,
  );

  // M-11 (mig 16): sleep-time focus block rewriter. Runs AFTER pruneFocus so
  // dropped/merged keys never reach the rewrite synthesis step. Writes go
  // exclusively to layer1_focus_shadow — real layer1_focus stays untouched
  // until a manual flip. Default off via env gate (NIGHT_CYCLE_FOCUS_REWRITE_
  // ENABLED). Errors per-key tracked separately from step-level throws.
  await runStep(
    "Focus rewrite (shadow)",
    "Focus rewrite",
    async () => {
      const r = await runFocusRewrite({ memory, router });
      result.focusRewritten = r.rewritten;
      result.focusSkipped = r.skipped;
      result.focusErrors = r.errors;
      log.info(`focus-rewrite: rewritten=${r.rewritten} skipped=${r.skipped} errors=${r.errors}`);
    },
    result,
  );

  // Stale-task DELETE pass runs BEFORE pruneCompletedTasks: open >30d and
  // in_progress >7d are abandoned ingestion (autonomous/free-agent overflow);
  // skip the soft-cancel + 1d wait and just drop them.
  await runStep(
    "Prune stale tasks",
    "Prune stale tasks",
    async () => {
      const r = pruneStaleTasks(memory);
      result.staleOpenDeleted = r.openDeleted;
      result.staleInProgressDeleted = r.inProgressDeleted;
    },
    result,
  );

  await runStep(
    "Prune completed tasks",
    "Prune tasks",
    async () => {
      result.tasksPruned = await pruneCompletedTasks(memory, rag);
      log.info(`tasks pruned=${result.tasksPruned}`);
    },
    result,
  );

  await runStep(
    "Collect stray tasks",
    "Collect strays",
    async () => {
      result.straysCollected = await collectStrayTasks(memory, router);
      log.info(`strays migrated=${result.straysCollected}`);
    },
    result,
  );

  // MEM-6: cluster-merge near-duplicates + mark expired rows.
  await runStep(
    "Memory dedup (cluster + expire)",
    "Memory dedup",
    async () => {
      const r = await runMemoryDedup(memory, rag);
      result.sharedDeduped = r.shared;
      result.contextDeduped = r.context;
      result.expiredMarked = r.expired;
      log.info(`memory-dedup: shared=${r.shared}, context=${r.context}, expired=${r.expired}`);
    },
    result,
  );

  // M-03 (mig 13): decay salience scores so popularity bumps fade over
  // time. Pure SQL — runs after memory-dedup so superseded/expired rows
  // (which sit untouched here) don't pull pointless writes. Order is
  // intentional: dedup mutates rows, decay is read-then-multiply on the
  // already-cleaned set.
  await runStep(
    "Decay salience",
    "Decay salience",
    async () => {
      const r = await decaySalience(memory);
      result.salienceDecayed = r.shared + r.context + r.archive;
      log.info(`decay-salience: shared=${r.shared}, context=${r.context}, archive=${r.archive}`);
    },
    result,
  );

  // M-09: pure-cosine cross-layer dedup + archive→shared promote. Runs
  // AFTER memory-dedup + decay-salience so it sees the post-intra-dedup
  // substrate, and BEFORE reflect so reflect doesn't race against
  // archive-promote inserts that cross-layer would immediately re-supersede.
  // Skipped when memoryService is missing (legacy test ctor without 4th arg)
  // — promote pass needs `MemoryService.insertShared` for atomic embed-first.
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
    );
  }

  // M-06: CoALA reflect — promote frequently-accessed context patterns into
  // shared semantic facts + derives edges. Runs AFTER memory-dedup +
  // decay-salience + cross-layer-dedup so reflect sees the cleaned, decayed,
  // cross-layer-merged substrate. Skipped when memoryService is missing
  // (legacy test ctor without 4th arg).
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
    );
  }

  // M-04.1: rolling N-row vec embed for layer4_log. Runs LAST — heavy IO
  // (NVIDIA embed batches) is the lowest priority of all post-batch work,
  // so a slow / rate-limited NVIDIA never blocks dedup, decay, reflect or
  // cross-layer steps from completing. Default off-rail when
  // LOG_EMBED_ENABLED=false.
  await runStep(
    "Embed log (rolling N=10k)",
    "Embed log",
    async () => {
      const r = await runEmbedLog({ memory, rag });
      result.logEmbedded = r.embedded;
      result.logEvicted = r.evicted;
      result.logEmbedErrors = r.errors;
      log.info(`embed-log: embedded=${r.embedded} evicted=${r.evicted} errors=${r.errors}`);
    },
    result,
  );

  // PR-B: memory janitor — expire/dedup/legacy/done-tasks cleanup.
  await runStep(
    "Memory janitor (PR-B)",
    "Janitor",
    async () => {
      const r = await runJanitor(memory, rag, notifier);
      result.janitorExpiredDeleted = r.expiredDeleted;
      result.janitorDedupArchived = r.dedupArchived;
      result.janitorLegacyArchived = r.legacyArchived;
      result.janitorDoneTasksDeleted = r.doneTasksDeleted;
    },
    result,
  );
}

async function runStep(
  banner: string,
  errKey: string,
  fn: () => Promise<void>,
  result: NightCycleResult,
): Promise<void> {
  log.info(`${banner}…`);
  try {
    await fn();
  } catch (err) {
    const msg = (err as Error).message;
    log.error(`${banner} failed: ${msg}`);
    result.errors.push(`${errKey}: ${msg}`);
  }
}
