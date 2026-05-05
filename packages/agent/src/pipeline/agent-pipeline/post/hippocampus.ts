/**
 * Post-processing agentic hippocampus: tool-calling loop for memory persistence.
 * Default model: `coder` (devstral); `flash` lacks reliable tool_calls.
 * Tools: memory_search, memory_write, task_add, done.
 * Per-exchange task mutation budget = 3.
 */
import type { MemoryDB } from "@subbrain/core/db";
import type { RequestLogger } from "@subbrain/core/lib/logger";
import type { ModelRouter } from "@subbrain/core/lib/model-router";
import type { Message } from "@subbrain/providers/types";
import type { ToolExecutor } from "../../../mcp";
import type { TaskMutationBudget, ToolRegistry } from "../../../mcp/registry";
import type { RAGPipeline } from "../../../rag";

import { type WriteSharedArgs, writeContext, writeShared } from "./extractors";
import { getExtractorPrompt } from "./prompt";
import { POST_TOOLS } from "./tools";

type ParsedWrite =
  | { ok: true; layer: "shared" | "context"; args: WriteSharedArgs }
  | { ok: false; error: string };

function parseMemoryWriteArgs(raw: Record<string, unknown>): ParsedWrite {
  const layer = String(raw.layer || "context") === "shared" ? "shared" : "context";
  const category = String(raw.category || "fact").slice(0, 64);
  const content = String(raw.content || "").trim();
  const tags = String(raw.tags || "");
  const rawConf = raw.confidence;
  if (typeof rawConf !== "number" || !Number.isFinite(rawConf)) {
    return { ok: false, error: "confidence required (number 0..1)" };
  }
  if (!content) return { ok: false, error: "empty content" };
  const confidence = Math.min(1, Math.max(0, rawConf));
  const rawExp = raw.expires_at;
  const expires_at: number | null | undefined =
    rawExp === null ? null : typeof rawExp === "number" ? rawExp : undefined;
  const supersedes = Array.isArray(raw.supersedes)
    ? (raw.supersedes as unknown[]).filter((s): s is string => typeof s === "string")
    : undefined;
  return {
    ok: true,
    layer,
    args: { category, content, tags, confidence, expires_at, supersedes },
  };
}

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
  agentId: string | null;
}): Promise<HippocampusStats> {
  const {
    memory,
    router,
    rag,
    executor,
    registry,
    userMessage,
    assistantText,
    reasoning,
    requestId,
    log,
    agentId,
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
            hits.context = memory.searchContext(q, limit, agentId ? { agentId } : undefined);
          }
          if (layer === "all" || layer === "shared") {
            hits.shared = memory.searchShared(q, limit);
          }
          result = JSON.stringify(hits);
          break;
        }
        case "memory_write": {
          const parsed = parseMemoryWriteArgs(toolArgs);
          if (!parsed.ok) {
            result = JSON.stringify({ ok: false, error: parsed.error });
            break;
          }
          const wr =
            parsed.layer === "shared"
              ? await writeShared(memory, rag, router, parsed.args, log)
              : await writeContext(memory, rag, router, parsed.args, requestId, log, agentId);
          if (wr.ok) factsWritten++;
          result = JSON.stringify(wr);
          break;
        }
        case "task_add": {
          // H-4: full AgentToolContext with nullable capability fields. No
          // more `as unknown as` cast — task_add only reads executor +
          // taskBudget; the rest stay null and any handler that tries to
          // reach for router/room/etc. fails predictably with a null deref
          // (the agent-only handlers that need them already null-check).
          const out = await registry.callAsAgent("task_add", toolArgs, {
            executor,
            agentId,
            log,
            registry,
            router: null,
            room: null,
            dynamicTools: null,
            codeTools: null,
            taskBudget,
          });
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
