/**
 * NightCycle orchestrator (H-2): retry pass + main batch + anti-patterns +
 * post-batch maintenance steps. Heavy lifting lives in:
 *   - retry-queue.ts        — pure persistence helpers (no async).
 *   - batch.ts              — runRetryPass / runMainBatch loops.
 *   - process-session.ts    — single-session pipeline.
 *   - anti-patterns-step.ts — extract + embed + archive.
 *   - post-steps.ts         — contradictions + prune* + stray collection.
 */
import type { MemoryDB } from "../../db";
import type { ModelRouter } from "../../lib/model-router";
import type { RAGPipeline } from "../../rag";
import type { MemoryService } from "../../services/memory.service";
import { logger } from "../../lib/logger";
import {
  type NightCycleResult,
  BATCH_SIZE,
  FOCUS_KEY_LAST_PROCESSED,
} from "./types";
import { RETRY_FOCUS_KEY } from "./retry-queue";
import { runRetryPass, runMainBatch } from "./batch";
import { runAntiPatternsStep } from "./anti-patterns-step";
import { runPostBatchSteps } from "./post-steps";

const log = logger.child("night");

export type { NightCycleResult } from "./types";

function emptyResult(): NightCycleResult {
  return {
    processedLogs: 0,
    sessionsProcessed: 0,
    archiveEntriesCreated: 0,
    antiPatternsFound: 0,
    contradictionsResolved: 0,
    sharedPruned: 0,
    contextPruned: 0,
    focusPruned: 0,
    tasksPruned: 0,
    straysCollected: 0,
    sharedDeduped: 0,
    contextDeduped: 0,
    expiredMarked: 0,
    salienceDecayed: 0,
    reflectGroupsExamined: 0,
    reflectFactsPromoted: 0,
    reflectEdgesCreated: 0,
    reflectLLMFailures: 0,
    crossLayerPairsExamined: 0,
    crossLayerSupersedesAdded: 0,
    crossLayerPromotedToShared: 0,
    crossLayerErrors: 0,
    errors: [],
    lastProcessedId: 0,
  };
}

export class NightCycle {
  constructor(
    private memory: MemoryDB,
    private router: ModelRouter,
    private rag: RAGPipeline,
    private memoryService?: MemoryService,
  ) {}

  async run(): Promise<NightCycleResult> {
    const result = emptyResult();
    const startedAt = Date.now();
    const deps = {
      memory: this.memory,
      router: this.router,
      rag: this.rag,
      memoryService: this.memoryService,
    };
    log.info("Cycle started");

    const lastIdStr = this.memory.getFocus(FOCUS_KEY_LAST_PROCESSED);
    const lastProcessedId = lastIdStr ? parseInt(lastIdStr, 10) : 0;
    const logs = this.memory.getLogsSince(lastProcessedId, BATCH_SIZE);
    if (logs.length === 0) {
      log.info("No unprocessed logs — nothing to do");
      return result;
    }

    result.processedLogs = logs.length;
    result.lastProcessedId = logs[logs.length - 1].id;
    const sessions = this.memory.groupLogsBySession(logs);
    result.sessionsProcessed = sessions.size;
    log.info(
      `Processing ${logs.length} logs across ${sessions.size} sessions (lastId: ${lastProcessedId} → ${result.lastProcessedId})`,
    );

    const survivors = await runRetryPass(deps, result);
    const finalQueue = await runMainBatch(deps, sessions, survivors, result);
    this.memory.setFocus(RETRY_FOCUS_KEY, JSON.stringify(finalQueue));

    await runAntiPatternsStep(deps, logs, result);
    await runPostBatchSteps(deps, result);

    this.memory.setFocus(FOCUS_KEY_LAST_PROCESSED, String(result.lastProcessedId));
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    log.info(
      `Cycle finished in ${elapsedSec}s — archived=${result.archiveEntriesCreated} antiPatterns=${result.antiPatternsFound} contradictions=${result.contradictionsResolved} sharedPruned=${result.sharedPruned} contextPruned=${result.contextPruned} focusPruned=${result.focusPruned} tasksPruned=${result.tasksPruned} strays=${result.straysCollected} sharedDeduped=${result.sharedDeduped} contextDeduped=${result.contextDeduped} expired=${result.expiredMarked} salienceDecayed=${result.salienceDecayed} reflectGroups=${result.reflectGroupsExamined} reflectPromoted=${result.reflectFactsPromoted} reflectEdges=${result.reflectEdgesCreated} reflectFailures=${result.reflectLLMFailures} crossPairs=${result.crossLayerPairsExamined} crossSupersedes=${result.crossLayerSupersedesAdded} crossPromoted=${result.crossLayerPromotedToShared} crossErrors=${result.crossLayerErrors} errors=${result.errors.length}`,
      { meta: { ...result } },
    );
    return result;
  }
}
