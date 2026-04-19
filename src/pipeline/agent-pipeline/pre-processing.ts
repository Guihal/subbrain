/**
 * Stage 1: Pre-processing — RAG search + focus/shared memory + hippocampus summary.
 */
import type { MemoryDB } from "../../db";
import type { ModelRouter } from "../../lib/model-router";
import type { RAGPipeline, RAGResult } from "../../rag";
import { logger } from "../../lib/logger";
import type { PreProcessingOutput } from "./types";

function getHippocampusPrompt(): string {
  const today = new Date().toLocaleDateString("ru-RU", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  return `You are the Hippocampus — the memory retrieval subsystem of Subbrain, a Digital Team AI infrastructure.
Today's date: ${today}.

Your function: Given a user's message and a raw memory dump (shared facts, RAG results, focus directives), produce a concise **Executive Summary** that the main AI agent needs to handle this request.

## Rules:
1. **Task-relevant context first** — prioritize facts, decisions, code context directly related to the user's current message.
2. **General user context second** — always include a brief reminder of who the user is (name, conditions, goals) so the agent maintains continuity.
3. **Verified facts only** — never hallucinate or infer facts not present in the memory dump. If unsure, say "no data".
4. **Timestamps** — when a memory entry has a date, include it. Format: [YYYY-MM-DD].
5. **Language** — write the summary in the same language as the user's message (usually Russian).
6. **Brevity** — max 400 words. Use bullet points. No preamble, no "Here is the summary".
7. **Structure**:
   - **Контекст задачи:** (what's relevant to the current request)
   - **О пользователе:** (brief user profile reminder)
   - **Активные проекты/дедлайны:** (if any are known)

You are silent infrastructure. The user never sees your output directly — only the main agent does.`;
}

export async function preProcess(
  memory: MemoryDB,
  router: ModelRouter,
  rag: RAGPipeline,
  userMessage: string,
  _sessionId: string,
  onProgress?: (msg: string) => void,
): Promise<PreProcessingOutput> {
  onProgress?.("🔍 Поиск в памяти (RAG + FTS + shared)...\n");
  const [ragResults, focusEntries, sharedMemory] = await Promise.all([
    rag.search({ query: userMessage, rerankTopN: 5 }).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("pre", `RAG search failed (degrading gracefully): ${msg}`);
      onProgress?.(
        `⚠️ RAG недоступен: ${msg.slice(0, 80)}, продолжаем без него...\n`,
      );
      return [] as RAGResult[];
    }),
    Promise.resolve(memory.getAllFocus()),
    Promise.resolve(memory.getAllShared()),
  ]);

  onProgress?.(
    `📚 Найдено ${ragResults.length} фрагментов, ${Object.keys(focusEntries).length} директив, ${sharedMemory.length} фактов\n`,
  );

  // Build raw memory block
  const rawParts: string[] = [];

  if (sharedMemory.length > 0) {
    rawParts.push("### Shared Memory (user facts)");
    for (const s of sharedMemory) {
      rawParts.push(`- [${s.category}] ${s.content}`);
    }
  }

  if (ragResults.length > 0) {
    rawParts.push("\n### RAG Results (task-relevant)");
    for (const r of ragResults) {
      const ts = r.updated_at || r.created_at;
      const date = ts
        ? ` [${new Date(ts * 1000).toISOString().slice(0, 16).replace("T", " ")}]`
        : "";
      rawParts.push(`- (${r.layer})${date} **${r.title}**: ${r.snippet}`);
    }
  }

  const rawMemoryBlock = rawParts.join("\n");

  if (ragResults.length === 0 && sharedMemory.length === 0) {
    return {
      executiveSummary: "",
      ragResults: [],
      focusEntries,
      sharedMemory: [],
      rawMemoryBlock: "",
    };
  }

  // Ask flash hippocampus for executive summary
  onProgress?.("🧠 Гиппокамп собирает Executive Summary...\n");

  const summaryResponse = await router.chat(
    "flash",
    {
      messages: [
        { role: "system", content: getHippocampusPrompt() },
        {
          role: "user",
          content: `User message: "${userMessage}"\n\nMemory dump:\n${rawMemoryBlock}`,
        },
      ],
      max_tokens: 1024,
      temperature: 0.3,
    },
    "normal",
  );

  const executiveSummary =
    summaryResponse.choices[0]?.message?.content ||
    (summaryResponse.choices[0]?.message as any)?.reasoning_content ||
    "";

  onProgress?.(`✅ Контекст собран (${executiveSummary.length} символов)\n`);

  return {
    executiveSummary,
    ragResults,
    focusEntries,
    sharedMemory,
    rawMemoryBlock,
  };
}
