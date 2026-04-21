/**
 * Post-processing agentic hippocampus: tool-calling loop that decides what to
 * persist into long-term memory after each user↔assistant exchange.
 *
 * Default model is `coder` (devstral) — `flash` (stepfun) is a reasoning model
 * and does not reliably emit tool_calls, so it cannot be used here.
 */
import type { MemoryDB } from "../../../db";
import type { ModelRouter } from "../../../lib/model-router";
import type { RAGPipeline } from "../../../rag";
import type { Tool, Message } from "../../../providers/types";
import type { RequestLogger } from "../../../lib/logger";

import { writeShared, writeContext } from "./extractors";

const MAX_HIPPO_STEPS = 5;
const MAX_SNIPPET_CHARS = 12_000;

const EXTRACTOR_MODEL = process.env.POST_EXTRACTOR_MODEL || "coder";

const POST_TOOLS: Tool[] = [
  {
    type: "function",
    function: {
      name: "memory_search",
      description:
        "FTS5 search across memory layers. Use to check whether a candidate fact is already stored before writing a duplicate.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          layer: {
            type: "string",
            enum: ["context", "shared", "all"],
            description: "Default: all",
          },
          limit: { type: "number", description: "Default: 5" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_write",
      description:
        "Persist one fact. Use `shared` for long-lived facts about the user / their life / persistent preferences. Use `context` for project decisions, code findings, transient domain knowledge.",
      parameters: {
        type: "object",
        properties: {
          layer: { type: "string", enum: ["context", "shared"] },
          category: {
            type: "string",
            description:
              "Short category tag: user, project, decision, finding, url, preference, etc.",
          },
          content: {
            type: "string",
            description: "Self-contained fact, one or two sentences.",
          },
          tags: {
            type: "string",
            description: "Comma-separated, optional",
          },
        },
        required: ["layer", "category", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "done",
      description:
        "Finish extraction. Call this once you've either written all worthwhile facts or determined the exchange has nothing new.",
      parameters: {
        type: "object",
        properties: {
          note: {
            type: "string",
            description: "Optional short debug note about what you did.",
          },
        },
      },
    },
  },
];

function getExtractorPrompt(): string {
  return `Ты — Hippocampus Write-Path, подсистема записи фактов в долгосрочную память после user↔assistant exchange.

## Стратегия: write-first (важно)
Пиши факты СРАЗУ через \`memory_write\`. НЕ начинай с \`memory_search\` — бюджет ${MAX_HIPPO_STEPS} шагов слишком тесен. Дубли отсеет night-cycle dedup; задача этого шага — ничего не потерять.

## Workflow
1. Прочти exchange. Идентифицируй до ~5 кандидатов (биография, решения, URL, числа, открытые ветки).
2. Вызови \`memory_write\` для самых уверенных фактов СРАЗУ.
3. \`memory_search\` только если кандидат почти дословно звучит как повтор (редкий случай).
4. Записал уверенные — \`done\`.

## Layers
- \`layer: "shared"\` — про пользователя/жизнь/долгоживущие предпочтения.
- \`layer: "context"\` — знания по проекту/коду/текущей задаче.

## Правила
- **Только факты из exchange** — ничего не выдумывай.
- **Самодостаточные** — каждый факт читается без окружения.
- **Пропусти** приветствия, мета-обсуждения, tool-шум.
- **Язык:** RU если exchange на RU.
- Нечего сохранять → сразу \`done\`.
- Budget: ${MAX_HIPPO_STEPS} tool calls. write > search.`;
}

export interface HippocampusStats {
  factsWritten: number;
  searchCalls: number;
  steps: number;
}

export async function runHippocampus(args: {
  memory: MemoryDB;
  router: ModelRouter;
  rag: RAGPipeline;
  userMessage: string;
  assistantText: string;
  reasoning?: string;
  requestId: string;
  log: RequestLogger;
}): Promise<HippocampusStats> {
  const { memory, router, rag, userMessage, assistantText, reasoning, requestId, log } = args;

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
    { role: "system", content: getExtractorPrompt() },
    { role: "user", content: exchangeBlock },
  ];

  let factsWritten = 0;
  let searchCalls = 0;
  let steps = 0;

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
      log.debug(
        "post",
        `${EXTRACTOR_MODEL} ended without tool calls after ${steps} steps. Content: ${content.slice(0, 200)}`,
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
            hits.context = memory.searchContext(q, limit);
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
          if (!content) {
            result = JSON.stringify({ ok: false, error: "empty content" });
            break;
          }
          const wr =
            layer === "shared"
              ? writeShared(memory, { category, content, tags }, log)
              : writeContext(memory, rag, { category, content, tags }, requestId, log);
          if (wr.ok) factsWritten++;
          result = JSON.stringify(wr);
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

  return { factsWritten, searchCalls, steps };
}
