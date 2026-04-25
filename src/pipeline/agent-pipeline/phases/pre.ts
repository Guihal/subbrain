/**
 * Pre-processing phase orchestrator.
 *
 * - First message in a chat → run agentic hippocampus to assemble executive summary + RAG hits.
 * - Continuation → only inject focus + shared facts (no model call).
 *
 * Returns enriched system prompt + stats for metrics/logging.
 */
import type { MemoryDB } from "../../../db";
import type { ModelRouter } from "../../../lib/model-router";
import type { RAGPipeline, RAGResult } from "../../../rag";
import type { PreProcessingOutput } from "../types";
import { buildSystemPrompt } from "../helpers";
import { loadFocusSeed, buildSeedContext } from "../pre/focus-inject";
import { buildExecutiveSummary } from "../pre/exec-summary";

export interface PreStats {
  ragCount: number;
  focusKeys: string[];
  summaryLen: number;
  steps: number;
}

export interface PreResult {
  enrichedSystemPrompt: string;
  preOutput: PreProcessingOutput;
  stats: PreStats;
}

export async function runPre(args: {
  memory: MemoryDB;
  router: ModelRouter;
  rag: RAGPipeline;
  model: string;
  userMessage: string;
  firstMessage: boolean;
  onProgress?: (msg: string) => void;
  /** B-1: per-agent identity for context-layer scoping; null = unscoped. */
  agentId?: string | null;
}): Promise<PreResult> {
  const {
    memory, router, rag, model, userMessage, firstMessage, onProgress,
    agentId = null,
  } = args;

  const seed = loadFocusSeed(memory);

  // Continuation: skip the agentic loop, just inject focus + shared.
  if (!firstMessage) {
    const preOutput: PreProcessingOutput = {
      executiveSummary: "",
      ragResults: [],
      focusEntries: seed.focusEntries,
      sharedMemory: seed.sharedMemory,
      rawMemoryBlock: "",
    };
    return {
      enrichedSystemPrompt: buildSystemPrompt(preOutput, model),
      preOutput,
      stats: {
        ragCount: 0,
        focusKeys: Object.keys(seed.focusEntries),
        summaryLen: 0,
        steps: 0,
      },
    };
  }

  onProgress?.("🔍 Загрузка директив и фактов...\n");
  onProgress?.(
    `📚 ${Object.keys(seed.focusEntries).length} директив, ${seed.sharedMemory.length} фактов\n`,
  );

  // Empty memory → nothing to search, return seed-only context.
  if (
    seed.sharedMemory.length === 0 &&
    Object.keys(seed.focusEntries).length === 0
  ) {
    const preOutput: PreProcessingOutput = {
      executiveSummary: "",
      ragResults: [],
      focusEntries: seed.focusEntries,
      sharedMemory: [],
      rawMemoryBlock: "",
    };
    return {
      enrichedSystemPrompt: buildSystemPrompt(preOutput, model),
      preOutput,
      stats: { ragCount: 0, focusKeys: [], summaryLen: 0, steps: 0 },
    };
  }

  const seedContext = buildSeedContext(seed);
  const exec = await buildExecutiveSummary({
    router,
    memory,
    rag,
    userMessage,
    seedContext,
    onProgress,
    agentId,
  });

  const rawMemoryBlock = buildRawMemoryBlock(seedContext, exec.ragResults);

  onProgress?.(
    `✅ Контекст собран за ${exec.steps} шагов (${exec.summary.length} символов)\n`,
  );

  const preOutput: PreProcessingOutput = {
    executiveSummary: exec.summary,
    ragResults: exec.ragResults,
    focusEntries: seed.focusEntries,
    sharedMemory: seed.sharedMemory,
    rawMemoryBlock,
  };

  return {
    enrichedSystemPrompt: buildSystemPrompt(preOutput, model),
    preOutput,
    stats: {
      ragCount: exec.ragResults.length,
      focusKeys: Object.keys(seed.focusEntries),
      summaryLen: exec.summary.length,
      steps: exec.steps,
    },
  };
}

function buildRawMemoryBlock(
  seedContext: string,
  ragResults: RAGResult[],
): string {
  const parts: string[] = [];
  if (seedContext) parts.push(seedContext);
  if (ragResults.length > 0) {
    parts.push("\n### RAG Results (task-relevant)");
    for (const r of ragResults) {
      const ts = r.updated_at || r.created_at;
      const date = ts
        ? ` [${new Date(ts * 1000).toISOString().slice(0, 16).replace("T", " ")}]`
        : "";
      parts.push(`- (${r.layer})${date} **${r.title}**: ${r.snippet}`);
    }
  }
  return parts.join("\n");
}
