/**
 * Agentic hippocampus loop — searches memory iteratively and emits an
 * Executive Summary. Capped by step count and wall-clock budget.
 */
import type { MemoryDB } from "../../../db";
import type { ModelRouter } from "../../../lib/model-router";
import type { RAGPipeline, RAGResult } from "../../../rag";
import type { Message } from "../../../providers/types";
import { logger } from "../../../lib/logger";

import { HIPPO_TOOLS, executeHippoTool } from "./rag-inject";

const log = logger.child("pre");

const MAX_HIPPO_STEPS = 6;
const HIPPO_TIMEOUT_MS = 25_000;

function getHippocampusPrompt(): string {
  const today = new Date().toLocaleDateString("ru-RU", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  return `You are the Hippocampus — the memory retrieval subsystem of Subbrain, a Digital Team AI infrastructure.
Today's date: ${today}.

You work in **agentic mode**: you have tools to actively search the memory database and gather all relevant context before producing your output.

## Your workflow:
1. **Analyze** the user's message and the seed context (focus directives + shared facts) provided below.
2. **Search actively** — use \`memory_search\` (free, FTS) and \`rag_search\` (precise, 1-2 RPM) to find task-relevant memories, past decisions, code context, project history.
3. **Iterate** — if initial results hint at more relevant context, do follow-up searches with refined queries.
4. **Stop searching** once you have enough context (don't search forever — ${MAX_HIPPO_STEPS} tool calls max).
5. **Produce the final output** as a text message (not a tool call) — the Executive Summary.

## Executive Summary format:
- **Контекст задачи:** (facts, decisions, code context directly related to the user's current request)
- **О пользователе:** (brief user profile reminder — name, conditions, goals)
- **Активные проекты/дедлайны:** (if any are known)

## Rules:
- **Verified facts only** — never hallucinate or infer facts not in the memory. If unsure, say "no data".
- **Timestamps** — include dates from memory entries when present. Format: [YYYY-MM-DD].
- **Language** — same as user's message (usually Russian).
- **Brevity** — max 500 words. Bullet points. No preamble.
- Start with tool calls to gather context. The final text message IS the executive summary.

You are silent infrastructure. The user never sees your output — only the main agent does.`;
}

export interface ExecutiveSummaryResult {
  summary: string;
  ragResults: RAGResult[];
  steps: number;
}

export async function buildExecutiveSummary(args: {
  router: ModelRouter;
  memory: MemoryDB;
  rag: RAGPipeline;
  userMessage: string;
  seedContext: string;
  onProgress?: (msg: string) => void;
}): Promise<ExecutiveSummaryResult> {
  const { router, memory, rag, userMessage, seedContext, onProgress } = args;

  onProgress?.("🧠 Гиппокамп (агентный режим) собирает контекст...\n");

  const allRagResults: RAGResult[] = [];
  const messages: Message[] = [
    { role: "system", content: getHippocampusPrompt() },
    {
      role: "user",
      content: `User message: "${userMessage}"\n\nSeed context:\n${seedContext}`,
    },
  ];

  let steps = 0;
  let summary = "";
  const start = Date.now();

  while (steps < MAX_HIPPO_STEPS) {
    if (Date.now() - start > HIPPO_TIMEOUT_MS) {
      log.warn(`Hippocampus time budget exhausted (${HIPPO_TIMEOUT_MS}ms)`);
      onProgress?.("⏱️ Лимит времени гиппокампа — финализация...\n");
      break;
    }

    let response;
    try {
      response = await router.chat(
        "coder",
        { messages, tools: HIPPO_TOOLS, max_tokens: 2048, temperature: 0.3 },
        "normal",
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.warn(`Hippocampus router.chat failed at step ${steps}: ${errMsg}`);
      onProgress?.(`⚠️ Ошибка гиппокампа: ${errMsg.slice(0, 100)}\n`);
      break;
    }

    const choice = response.choices[0];
    if (!choice) break;
    const msg = choice.message;

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      summary = msg.content || msg.reasoning_content || "";
      break;
    }

    messages.push({
      role: "assistant",
      content: msg.content || null,
      tool_calls: msg.tool_calls,
    });

    for (const tc of msg.tool_calls) {
      steps++;
      let toolArgs: Record<string, unknown>;
      try {
        toolArgs = JSON.parse(tc.function.arguments);
      } catch {
        toolArgs = {};
      }

      log.debug(
        `Hippocampus tool: ${tc.function.name}(${JSON.stringify(toolArgs).slice(0, 200)})`,
      );
      onProgress?.(
        `  🔧 ${tc.function.name}(${((toolArgs.query as string) || "").slice(0, 60)})\n`,
      );

      const { result, ragResults } = await executeHippoTool(
        tc.function.name,
        toolArgs,
        memory,
        rag,
      );

      if (ragResults) allRagResults.push(...ragResults);

      messages.push({
        role: "tool",
        content: result.slice(0, 8000),
        tool_call_id: tc.id,
      });
    }

    log.debug(`Hippocampus step ${steps}/${MAX_HIPPO_STEPS}`);
  }

  if (!summary && steps >= MAX_HIPPO_STEPS) {
    onProgress?.("⏱️ Лимит шагов — финализация...\n");
    messages.push({
      role: "user",
      content:
        "You've reached the search limit. Now produce the Executive Summary based on everything you've gathered.",
    });
    const final = await router.chat(
      "coder",
      { messages, max_tokens: 2048, temperature: 0.3 },
      "normal",
    );
    summary =
      final.choices[0]?.message?.content ||
      final.choices[0]?.message?.reasoning_content ||
      "";
  }

  return { summary, ragResults: allRagResults, steps };
}
