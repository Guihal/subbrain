/**
 * Post-processing hippocampus: tool-calling loop for memory persistence.
 * Tools: memory_search, memory_write, task_add, done.
 */
import type { MemoryDB } from "@subbrain/core/db";
import type { RequestLogger } from "@subbrain/core/lib/logger";
import type { Message } from "@subbrain/providers/types";
import type { ModelRouter } from "@subbrain/core/lib/model-router";
import type { ToolExecutor } from "../../../mcp";
import type { TaskMutationBudget, ToolRegistry } from "../../../mcp/registry";
import type { RAGPipeline } from "../../../rag";

import { createWriteGuard, emitHippoTelemetry } from "./cap-guard";
import { NUDGE_NO_TOOL } from "./parse-write";
import { CONFIDENCE_RULE, getExtractorPrompt } from "./prompt";
import { processToolCall } from "./process-tool";
import { POST_TOOLS } from "./tools";

const MAX_HIPPO_STEPS = 5;
const MAX_SNIPPET_CHARS = 12_000;
const TASK_BUDGET_PER_EXCHANGE = 3;
const MAX_NUDGES = 1;

const EXTRACTOR_MODEL = process.env.POST_EXTRACTOR_MODEL || "memory";

export interface HippocampusStats {
  factsWritten: number;
  tasksAdded: number;
  searchCalls: number;
  steps: number;
}

export async function runHippocampus(args: {
  memory: MemoryDB;
  router: ModelRouter;
  rag: RAGPipeline;
  executor: ToolExecutor;
  registry: ToolRegistry;
  userMessage: string;
  assistantText: string;
  reasoning?: string;
  requestId: string;
  log: RequestLogger;
  agentId: string | null;
}): Promise<HippocampusStats> {
  const { memory, router, rag, executor, registry, userMessage, assistantText, reasoning, requestId, log, agentId } = args;

  const exchangeBlock = [
    `=== User ===`,
    userMessage.slice(0, MAX_SNIPPET_CHARS),
    `=== Assistant ===`,
    assistantText.slice(0, MAX_SNIPPET_CHARS),
    reasoning && reasoning !== assistantText
      ? `=== Assistant reasoning ===\n${reasoning.slice(0, MAX_SNIPPET_CHARS)}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const messages: Message[] = [
    { role: "system", content: getExtractorPrompt(MAX_HIPPO_STEPS) + CONFIDENCE_RULE },
    { role: "user", content: exchangeBlock },
  ];

  const taskBudget: TaskMutationBudget = { remaining: TASK_BUDGET_PER_EXCHANGE };

  let factsWritten = 0;
  let tasksAdded = 0;
  let searchCalls = 0;
  let steps = 0;
  let nudgesUsed = 0;
  const guard = createWriteGuard();

  while (steps < MAX_HIPPO_STEPS) {
    const response = await router.chat(
      EXTRACTOR_MODEL,
      { messages, tools: POST_TOOLS, tool_choice: "auto", max_tokens: 1024, temperature: 0.2 },
      "low",
    );

    const choice = response.choices[0];
    if (!choice) break;
    const msg = choice.message;

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      const content = msg.content || msg.reasoning_content || "";
      if (nudgesUsed < MAX_NUDGES) {
        nudgesUsed++;
        log.debug("post", `${EXTRACTOR_MODEL} text-only response at step ${steps}, nudging (${nudgesUsed}/${MAX_NUDGES}). Content: ${content.slice(0, 200)}`);
        if (content) messages.push({ role: "assistant", content });
        messages.push({ role: "user", content: NUDGE_NO_TOOL });
        continue;
      }
      log.debug("post", `${EXTRACTOR_MODEL} ended without tool calls after ${steps} steps (nudge exhausted). Content: ${content.slice(0, 200)}`);
      break;
    }

    messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: msg.tool_calls });

    let finished = false;
    for (const tc of msg.tool_calls) {
      steps++;
      let toolArgs: Record<string, unknown>;
      try { toolArgs = JSON.parse(tc.function.arguments); } catch { toolArgs = {}; }

      const tr = await processToolCall({
        name: tc.function.name,
        toolArgs,
        guard,
        requestId,
        agentId,
        log,
        memory,
        rag,
        router,
        executor,
        registry,
        taskBudget,
      });

      factsWritten += tr.factsWritten;
      tasksAdded += tr.tasksAdded;
      searchCalls += tr.searchCalls;
      finished = tr.finished;

      messages.push({ role: "tool", content: tr.result, tool_call_id: tc.id });
      if (finished) break;
    }
    if (finished) break;
  }

  emitHippoTelemetry(guard, requestId, steps, log);
  return { factsWritten, tasksAdded, searchCalls, steps };
}
