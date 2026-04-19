/**
 * Stage 1: Pre-processing — Agentic hippocampus gathers full context via tool calls.
 *
 * The hippocampus (gpt-5-mini via flash role) runs in agentic mode:
 * 1. Receives focus directives + shared memory as seed context
 * 2. Uses memory_search / rag_search tools to iteratively gather relevant memories
 * 3. Produces an Executive Summary once it has enough context
 * 4. Hard cap at MAX_HIPPO_STEPS to bound latency
 */
import type { MemoryDB } from "../../db";
import type { ModelRouter } from "../../lib/model-router";
import type { RAGPipeline, RAGResult } from "../../rag";
import type { Tool, Message } from "../../providers/types";
import { logger } from "../../lib/logger";
import type { PreProcessingOutput } from "./types";

const MAX_HIPPO_STEPS = 6;
const HIPPO_TIMEOUT_MS = 25_000; // 25s hard cap for the entire hippo loop

const HIPPO_TOOLS: Tool[] = [
  {
    type: "function",
    function: {
      name: "memory_search",
      description:
        "FTS5 full-text search across memory layers. Fast, no RPM cost.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          layer: {
            type: "string",
            enum: ["context", "archive", "shared", "all"],
            description: "Which layer to search (default: all)",
          },
          limit: {
            type: "number",
            description: "Max results (default: 10)",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "rag_search",
      description:
        "Hybrid RAG: FTS5 + vector embeddings → rerank. More accurate but costs 1-2 RPM. Use when FTS is insufficient.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          top_n: {
            type: "number",
            description: "Top N results after rerank (default: 5)",
          },
        },
        required: ["query"],
      },
    },
  },
];

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

/** Execute a hippocampus tool call against local memory/RAG */
async function executeHippoTool(
  name: string,
  args: Record<string, unknown>,
  memory: MemoryDB,
  rag: RAGPipeline,
): Promise<{ result: string; ragResults?: RAGResult[] }> {
  switch (name) {
    case "memory_search": {
      const query = args.query as string;
      const layer = (args.layer as string) || "all";
      const limit = (args.limit as number) || 10;
      const results: Record<string, unknown[]> = {};
      if (layer === "all" || layer === "context")
        results.context = memory.searchContext(query, limit);
      if (layer === "all" || layer === "archive")
        results.archive = memory.searchArchive(query, limit);
      if (layer === "all" || layer === "shared")
        results.shared = memory.searchShared(query, limit);
      return { result: JSON.stringify(results) };
    }
    case "rag_search": {
      const query = args.query as string;
      const topN = (args.top_n as number) || 5;
      try {
        const ragResults = await rag.search({ query, rerankTopN: topN });
        return {
          result: JSON.stringify(ragResults),
          ragResults,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { result: JSON.stringify({ error: msg }) };
      }
    }
    default:
      return { result: JSON.stringify({ error: `Unknown tool: ${name}` }) };
  }
}

export async function preProcess(
  memory: MemoryDB,
  router: ModelRouter,
  rag: RAGPipeline,
  userMessage: string,
  _sessionId: string,
  onProgress?: (msg: string) => void,
): Promise<PreProcessingOutput> {
  onProgress?.("🔍 Загрузка директив и фактов...\n");

  // Seed context: always load focus + shared (cheap, local)
  const [focusEntries, sharedMemory] = await Promise.all([
    Promise.resolve(memory.getAllFocus()),
    Promise.resolve(memory.getAllShared()),
  ]);

  onProgress?.(
    `📚 ${Object.keys(focusEntries).length} директив, ${sharedMemory.length} фактов\n`,
  );

  // Build seed context for hippocampus
  const seedParts: string[] = [];
  if (Object.keys(focusEntries).length > 0) {
    seedParts.push("### Focus Directives");
    for (const [key, value] of Object.entries(focusEntries)) {
      seedParts.push(`- **${key}:** ${value}`);
    }
  }
  if (sharedMemory.length > 0) {
    seedParts.push("\n### Shared Memory (user facts)");
    for (const s of sharedMemory) {
      seedParts.push(`- [${s.category}] ${s.content}`);
    }
  }
  const seedContext = seedParts.join("\n");

  // If no shared memory at all, skip agentic loop — nothing to search
  if (sharedMemory.length === 0 && Object.keys(focusEntries).length === 0) {
    return {
      executiveSummary: "",
      ragResults: [],
      focusEntries,
      sharedMemory: [],
      rawMemoryBlock: "",
    };
  }

  // ─── Agentic hippocampus loop ───────────────────────────
  onProgress?.("🧠 Гиппокамп (агентный режим) собирает контекст...\n");

  const allRagResults: RAGResult[] = [];
  const rawParts: string[] = [];
  if (seedContext) rawParts.push(seedContext);

  const messages: Message[] = [
    { role: "system", content: getHippocampusPrompt() },
    {
      role: "user",
      content: `User message: "${userMessage}"\n\nSeed context:\n${seedContext}`,
    },
  ];

  let steps = 0;
  let executiveSummary = "";
  const hippoStart = Date.now();

  while (steps < MAX_HIPPO_STEPS) {
    // Time budget check
    if (Date.now() - hippoStart > HIPPO_TIMEOUT_MS) {
      logger.warn("pre", `Hippocampus time budget exhausted (${HIPPO_TIMEOUT_MS}ms)`);
      onProgress?.("⏱️ Лимит времени гиппокампа — финализация...\n");
      break;
    }

    let response;
    try {
      response = await router.chat(
        "flash",
        {
          messages,
          tools: HIPPO_TOOLS,
          max_tokens: 2048,
          temperature: 0.3,
        },
        "normal",
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn("pre", `Hippocampus router.chat failed at step ${steps}: ${errMsg}`);
      onProgress?.(`⚠️ Ошибка гиппокампа: ${errMsg.slice(0, 100)}\n`);
      break;
    }

    const choice = response.choices[0];
    if (!choice) break;

    const msg = choice.message;

    // If model returns content without tool calls → it's the executive summary
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      executiveSummary = msg.content || (msg as any).reasoning_content || "";
      break;
    }

    // Append assistant message with tool calls
    messages.push({
      role: "assistant",
      content: msg.content || null,
      tool_calls: msg.tool_calls,
    });

    // Execute all tool calls
    for (const tc of msg.tool_calls) {
      steps++;
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(tc.function.arguments);
      } catch {
        args = {};
      }

      logger.debug(
        "pre",
        `Hippocampus tool: ${tc.function.name}(${JSON.stringify(args).slice(0, 200)})`,
      );
      onProgress?.(
        `  🔧 ${tc.function.name}(${((args.query as string) || "").slice(0, 60)})\n`,
      );

      const { result, ragResults } = await executeHippoTool(
        tc.function.name,
        args,
        memory,
        rag,
      );

      if (ragResults) {
        allRagResults.push(...ragResults);
      }

      // Append tool result
      messages.push({
        role: "tool",
        content: result.slice(0, 8000), // cap tool output size
        tool_call_id: tc.id,
      });
    }

    logger.debug("pre", `Hippocampus step ${steps}/${MAX_HIPPO_STEPS}`);
  }

  // If loop exhausted without a text response, force a final summary call
  if (!executiveSummary && steps >= MAX_HIPPO_STEPS) {
    onProgress?.("⏱️ Лимит шагов — финализация...\n");
    messages.push({
      role: "user",
      content:
        "You've reached the search limit. Now produce the Executive Summary based on everything you've gathered.",
    });
    const finalResponse = await router.chat(
      "flash",
      { messages, max_tokens: 2048, temperature: 0.3 },
      "normal",
    );
    executiveSummary =
      finalResponse.choices[0]?.message?.content ||
      (finalResponse.choices[0]?.message as any)?.reasoning_content ||
      "";
  }

  // Build raw memory block for system prompt injection
  if (allRagResults.length > 0) {
    rawParts.push("\n### RAG Results (task-relevant)");
    for (const r of allRagResults) {
      const ts = r.updated_at || r.created_at;
      const date = ts
        ? ` [${new Date(ts * 1000).toISOString().slice(0, 16).replace("T", " ")}]`
        : "";
      rawParts.push(`- (${r.layer})${date} **${r.title}**: ${r.snippet}`);
    }
  }
  const rawMemoryBlock = rawParts.join("\n");

  onProgress?.(
    `✅ Контекст собран за ${steps} шагов (${executiveSummary.length} символов)\n`,
  );

  return {
    executiveSummary,
    ragResults: allRagResults,
    focusEntries,
    sharedMemory,
    rawMemoryBlock,
  };
}
