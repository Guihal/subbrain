/**
 * Post-batch maintenance steps (H-2 split): contradictions + prune* +
 * stray-task migration. Each step is wrapped in a try/catch that pushes
 * errors into `result.errors` so one failed step never aborts the cycle.
 */
import type { MemoryDB } from "../../db";
import type { ModelRouter } from "../../lib/model-router";
import type { RAGPipeline } from "../../rag";
import { logger } from "../../lib/logger";
import { resolveContradictions, runMemoryDedup, decaySalience } from "./steps";
import {
  pruneShared,
  pruneContext,
  pruneFocus,
  pruneCompletedTasks,
  collectStrayTasks,
} from "./prune";
import type { NightCycleResult } from "./types";

const log = logger.child("night.post");

export async function runPostBatchSteps(
  deps: { memory: MemoryDB; router: ModelRouter; rag: RAGPipeline },
  result: NightCycleResult,
): Promise<void> {
  const { memory, router, rag } = deps;

  await runStep("Resolve contradictions", "Resolve", async () => {
    result.contradictionsResolved = await resolveContradictions(memory, router, rag);
  }, result);

  await runStep("Prune shared_memory", "Prune shared", async () => {
    result.sharedPruned = await pruneShared(memory, router);
    log.info(`shared pruned=${result.sharedPruned}`);
  }, result);

  await runStep("Prune layer2_context", "Prune context", async () => {
    result.contextPruned = await pruneContext(memory, router, rag);
    log.info(`context pruned=${result.contextPruned}`);
  }, result);

  await runStep("Prune layer1_focus", "Prune focus", async () => {
    result.focusPruned = await pruneFocus(memory, router);
    log.info(`focus pruned=${result.focusPruned}`);
  }, result);

  await runStep("Prune completed tasks", "Prune tasks", async () => {
    result.tasksPruned = await pruneCompletedTasks(memory, rag);
    log.info(`tasks pruned=${result.tasksPruned}`);
  }, result);

  await runStep("Collect stray tasks", "Collect strays", async () => {
    result.straysCollected = await collectStrayTasks(memory, router);
    log.info(`strays migrated=${result.straysCollected}`);
  }, result);

  // MEM-6: cluster-merge near-duplicates + mark expired rows.
  await runStep("Memory dedup (cluster + expire)", "Memory dedup", async () => {
    const r = await runMemoryDedup(memory, rag);
    result.sharedDeduped = r.shared;
    result.contextDeduped = r.context;
    result.expiredMarked = r.expired;
    log.info(
      `memory-dedup: shared=${r.shared}, context=${r.context}, expired=${r.expired}`,
    );
  }, result);

  // M-03 (mig 13): decay salience scores so popularity bumps fade over
  // time. Pure SQL — runs after memory-dedup so superseded/expired rows
  // (which sit untouched here) don't pull pointless writes. Order is
  // intentional: dedup mutates rows, decay is read-then-multiply on the
  // already-cleaned set.
  await runStep("Decay salience", "Decay salience", async () => {
    const r = await decaySalience(memory);
    result.salienceDecayed = r.shared + r.context + r.archive;
    log.info(
      `decay-salience: shared=${r.shared}, context=${r.context}, archive=${r.archive}`,
    );
  }, result);
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
