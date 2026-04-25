/**
 * Post-processing agentic hippocampus: tool-calling loop that decides what to
 * persist into long-term memory after each user↔assistant exchange.
 *
 * Default model is `coder` (devstral) — `flash` (stepfun) is a reasoning model
 * and does not reliably emit tool_calls, so it cannot be used here.
 *
 * Tool surface:
 *   - memory_search / memory_write — dispatched inline against MemoryDB + RAG.
 *   - task_add — dispatched through ToolRegistry so the rate-limit guard in
 *     tasks.tools.ts is the single source of truth.
 *   - done — terminates the loop.
 *
 * Per-exchange task mutation budget = 3 (add/update/start/done/cancel share
 * the counter). Budget lives in a single `TaskMutationBudget` object passed
 * into every registry.call, so all task_* handlers see the same `remaining`.
 */
import type { MemoryDB } from "../../../db";
import type { ModelRouter } from "../../../lib/model-router";
import type { RAGPipeline } from "../../../rag";
import type { Message } from "../../../providers/types";
import type { RequestLogger } from "../../../lib/logger";
import type { ToolExecutor } from "../../../mcp";
import type { ToolRegistry, TaskMutationBudget } from "../../../mcp/registry";

import { writeShared, writeContext } from "./extractors";
import { POST_TOOLS } from "./tools";
import { getExtractorPrompt } from "./prompt";

const MAX_HIPPO_STEPS = 5;
const MAX_SNIPPET_CHARS = 12_000;
const TASK_BUDGET_PER_EXCHANGE = 3;
const MAX_NUDGES = 1;
const NUDGE_NO_TOOL =
  "[Системная метка] Ответ текстом не сохранится в память. Используй memory_write/task_add для записи или done для завершения.";

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
  /** B-1: per-agent identity used to scope context-layer reads/writes. */
  agentId: string | null;
}): Promise<HippocampusStats> {
  const {
    memory, router, rag, executor, registry,
    userMessage, assistantText, reasoning, requestId, log, agentId,
  } = args;

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

  // MEM-5 (PR 22a): append a confidence-emission rule to the extractor prompt
  // without editing prompt.ts (which is shared with other callers). The suffix
  // makes `confidence` mandatory for every memory_write call and explains the
  // MEMORY_AUTOACCEPT_CONFIDENCE threshold so the model does not over-claim.
  const confidenceRule = [
    "",
    "## Confidence (обязательно для memory_write)",
    "При каждом `memory_write` указывай `confidence` (число 0..1):",
    "- 0.9+ = пользователь явно подтвердил факт.",
    "- 0.7–0.9 = сильное следствие из exchange.",
    "- <0.7 = догадка / слабая эвристика.",
    "Факты с confidence < 0.8 автоматически попадают в pending-очередь и не",
    "используются RAG до approval'а (default threshold: MEMORY_AUTOACCEPT_CONFIDENCE=0.8).",
  ].join("\n");

  const messages: Message[] = [
    { role: "system", content: getExtractorPrompt(MAX_HIPPO_STEPS) + confidenceRule },
    { role: "user", content: exchangeBlock },
  ];

  const taskBudget: TaskMutationBudget = { remaining: TASK_BUDGET_PER_EXCHANGE };

  let factsWritten = 0;
  let tasksAdded = 0;
  let searchCalls = 0;
  let steps = 0;
  let nudgesUsed = 0;

  while (steps < MAX_HIPPO_STEPS) {
    const response = await router.chat(
      EXTRACTOR_MODEL,
      {
        messages,
        tools: POST_TOOLS,
        tool_choice: "auto",
        max_tokens: 1024,
        temperature: 0.2,
      },
      "low",
    );

    const choice = response.choices[0];
    if (!choice) break;
    const msg = choice.message;

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      const content = msg.content || msg.reasoning_content || "";
      if (nudgesUsed < MAX_NUDGES) {
        nudgesUsed++;
        log.debug(
          "post",
          `${EXTRACTOR_MODEL} text-only response at step ${steps}, nudging (${nudgesUsed}/${MAX_NUDGES}). Content: ${content.slice(0, 200)}`,
        );
        if (content) {
          messages.push({ role: "assistant", content });
        }
        messages.push({ role: "user", content: NUDGE_NO_TOOL });
        continue;
      }
      log.debug(
        "post",
        `${EXTRACTOR_MODEL} ended without tool calls after ${steps} steps (nudge exhausted). Content: ${content.slice(0, 200)}`,
      );
      break;
    }

    messages.push({
      role: "assistant",
      content: msg.content ?? null,
      tool_calls: msg.tool_calls,
    });

    let finished = false;
    for (const tc of msg.tool_calls) {
      steps++;
      let toolArgs: Record<string, unknown>;
      try {
        toolArgs = JSON.parse(tc.function.arguments);
      } catch {
        toolArgs = {};
      }

      let result = "";
      switch (tc.function.name) {
        case "memory_search": {
          searchCalls++;
          const q = String(toolArgs.query || "");
          const layer = String(toolArgs.layer || "all");
          const limit = Number(toolArgs.limit) || 5;
          const hits: Record<string, unknown[]> = {};
          if (layer === "all" || layer === "context") {
            // B-1: scope context lookup to current agent (NULL rows visible).
            hits.context = memory.searchContext(
              q,
              limit,
              agentId ? { agentId } : undefined,
            );
          }
          if (layer === "all" || layer === "shared") {
            hits.shared = memory.searchShared(q, limit);
          }
          result = JSON.stringify(hits);
          break;
        }
        case "memory_write": {
          const layer = String(toolArgs.layer || "context");
          const category = String(toolArgs.category || "fact").slice(0, 64);
          const content = String(toolArgs.content || "").trim();
          const tags = String(toolArgs.tags || "");
          // MEM-5 (PR 22a): confidence is mandatory. A missing / non-numeric
          // value is reported back so the model can retry with a proper score
          // instead of silently landing as 'active'.
          const rawConfidence = toolArgs.confidence;
          if (typeof rawConfidence !== "number" || !Number.isFinite(rawConfidence)) {
            result = JSON.stringify({
              ok: false,
              error: "confidence required (number 0..1)",
            });
            break;
          }
          const confidence = Math.min(1, Math.max(0, rawConfidence));
          if (!content) {
            result = JSON.stringify({ ok: false, error: "empty content" });
            break;
          }
          const wr =
            layer === "shared"
              ? await writeShared(memory, rag, { category, content, tags, confidence }, log)
              : await writeContext(
                  memory,
                  rag,
                  { category, content, tags, confidence },
                  requestId,
                  log,
                  agentId,
                );
          if (wr.ok) factsWritten++;
          result = JSON.stringify(wr);
          break;
        }
        case "task_add": {
          // Hippocampus provides a minimal agent-like ctx: task_add only uses
          // ctx.executor + ctx.taskBudget; other AgentToolContext fields
          // (router/room/log/registry/dynamicTools/codeTools) are not touched.
          const out = await registry.callAsAgent("task_add", toolArgs, {
            executor,
            taskBudget,
          } as unknown as import("../../../mcp/registry/tool-registry").AgentToolContext);
          if (out.success) {
            tasksAdded++;
            const title = String(toolArgs.title || "").slice(0, 100);
            log.info("post", `→ task_add: ${title}`, {
              meta: { layer: "tasks", remaining: taskBudget.remaining },
            });
          } else {
            log.warn("post", `task_add rejected: ${out.error}`);
          }
          result = JSON.stringify(out);
          break;
        }
        case "done": {
          finished = true;
          result = JSON.stringify({ ok: true });
          break;
        }
        default:
          result = JSON.stringify({ error: `Unknown tool: ${tc.function.name}` });
      }

      messages.push({
        role: "tool",
        content: result,
        tool_call_id: tc.id,
      });

      if (finished) break;
    }

    if (finished) break;
  }

  return { factsWritten, tasksAdded, searchCalls, steps };
}
