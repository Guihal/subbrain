import type { MemoryDB } from "@subbrain/core/db";
import type { RAGPipeline } from "../../../rag";
import type { Notifier } from "../../../telegram/bot/notify";
import { runJanitor } from "../janitor";
import { runEmbedLog } from "../steps";
import type { NightCycleResult } from "../types";
import { runStep } from "./run-step";

export async function runJanitorPhase(
  deps: {
    memory: MemoryDB;
    rag: RAGPipeline;
    notifier?: Notifier;
  },
  result: NightCycleResult,
  signal?: AbortSignal,
): Promise<void> {
  const { memory, rag, notifier } = deps;

  // M-04.1: rolling N-row vec embed for layer4_log — runs LAST, heavy IO
  await runStep(
    "Embed log (rolling N=10k)",
    "Embed log",
    async () => {
      const r = await runEmbedLog({ memory, rag });
      result.logEmbedded = r.embedded;
      result.logEvicted = r.evicted;
      result.logEmbedErrors = r.errors;
    },
    result,
    signal,
  );

  // PR-B: memory janitor — expire/dedup/legacy/done-tasks cleanup
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
    signal,
  );
}
