/**
 * Stage 3: Post-processing — agentic knowledge extraction.
 *
 * Extractor model (default `coder`, override via POST_EXTRACTOR_MODEL) runs in
 * tool-calling mode after every user↔assistant exchange. It can search
 * existing memory (to avoid duplicates) and write new facts into
 * layer2_context or shared_memory. Priority is "low" so the rate limiter
 * queues these calls behind foreground work instead of dropping them.
 */
import { randomUUID } from "crypto";
import type { MemoryDB } from "../../db";
import type { ModelRouter } from "../../lib/model-router";
import type { RAGPipeline } from "../../rag";
import type { Tool, Message } from "../../providers/types";
import { logger, type RequestLogger } from "../../lib/logger";
import { parseSSEChunk } from "../../providers/sse-parser";

/** Minimum response length to trigger extraction */
const MIN_EXTRACTION_LENGTH = 100;
/** Hard cap on tool-calling iterations per exchange */
const MAX_HIPPO_STEPS = 5;
/** Max chars per message piece sent to the extractor (rough safety net) */
const MAX_SNIPPET_CHARS = 12_000;

/**
 * Virtual role used for extraction. Default is `coder` (NVIDIA devstral-2)
 * because `flash` (stepfun step-3.5) does not reliably emit tool_calls:
 * in prod it explains the exchange as plain text instead of calling
 * memory_search/memory_write. Override via POST_EXTRACTOR_MODEL env.
 */
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
          layer: {
            type: "string",
            enum: ["context", "shared"],
          },
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
  return `You are the Hippocampus Write-Path — the subsystem that decides what from a user↔assistant exchange is worth persisting into long-term memory.

Workflow:
1. Read the exchange below (full user message + full assistant response, possibly agent reasoning).
2. Identify up to ~5 candidate facts genuinely worth remembering: user biography, preferences, decisions made, URLs discovered, task outcomes, numeric findings, open threads.
3. For each candidate, call \`memory_search\` first to avoid writing something that's already stored. If found, skip it.
4. For each genuinely new fact, call \`memory_write\`:
   - \`layer: "shared"\` — facts about the user / their life / long-lived preferences.
   - \`layer: "context"\` — project/code/task-specific knowledge.
5. When finished, call \`done\`.

Rules:
- **Verified only** — never invent or paraphrase into something the exchange doesn't say.
- **Self-contained** — each fact must be understandable without the surrounding exchange.
- **Skip pleasantries, meta-chatter, budget notes, tool-call noise.**
- **Language:** match the exchange (usually Russian).
- If nothing is worth saving, just call \`done\` immediately.
- Hard budget: ${MAX_HIPPO_STEPS} tool calls total. Spend them wisely.`;
}

export async function postProcess(
  memory: MemoryDB,
  router: ModelRouter,
  rag: RAGPipeline,
  userMessage: string,
  assistantMessage: string,
  requestId: string,
  sessionId: string,
  model: string,
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  },
  reasoning?: string,
  options?: {
    skipRawLog?: boolean;
  },
): Promise<void> {
  const log = logger.forRequest(requestId, sessionId);
  log.info(
    "post",
    `Post-processing: user=${userMessage.length}ch assistant=${assistantMessage.length}ch`,
    { model },
  );

  // 1. Log the exchange to Layer 4 unless the caller already did so.
  if (!options?.skipRawLog) {
    memory.appendLog(requestId, sessionId, model, "user", userMessage);
    memory.appendLog(
      requestId,
      sessionId,
      model,
      "assistant",
      assistantMessage,
      usage?.completion_tokens,
    );

    // 1b. Log reasoning/thinking if present
    if (reasoning && reasoning.length > 0) {
      memory.appendLog(requestId, sessionId, model, "reasoning", reasoning);
      log.info("post", `Reasoning logged: ${reasoning.length} chars`, {
        model,
      });
    }
  }

  // 2. Agentic knowledge extraction via EXTRACTOR_MODEL.
  // Gate on the COMBINED length of user + assistant (+ reasoning): facts
  // often come from the user ("запомни X"), even when the assistant just
  // replies "ok". Skipping on short-assistant-only loses those.
  const assistantText = assistantMessage || reasoning || "";
  const combinedLen = (userMessage?.length ?? 0) + assistantText.length;
  if (combinedLen < MIN_EXTRACTION_LENGTH) {
    log.debug(
      "post",
      `Skipping: combined exchange too short (${combinedLen} < ${MIN_EXTRACTION_LENGTH})`,
    );
    return;
  }

  const extractionStart = Date.now();
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

  try {
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

      // No tool calls → treat as implicit done. Log what the model emitted
      // so we can distinguish "nothing worth saving" from "model silently
      // ignored the tool schema".
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        const content = msg.content || (msg as any).reasoning_content || "";
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
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          args = {};
        }

        let result = "";
        switch (tc.function.name) {
          case "memory_search": {
            searchCalls++;
            const q = String(args.query || "");
            const layer = String(args.layer || "all");
            const limit = Number(args.limit) || 5;
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
            const layer = String(args.layer || "context");
            const category = String(args.category || "fact").slice(0, 64);
            const content = String(args.content || "").trim();
            const tags = String(args.tags || "");
            if (!content) {
              result = JSON.stringify({ ok: false, error: "empty content" });
              break;
            }
            const id = randomUUID();
            try {
              if (layer === "shared") {
                memory.insertShared(id, category, content, tags, "post-processing");
              } else {
                memory.insertContext(id, category, content, tags, [requestId]);
                rag.indexEntry(id, "context", content).catch(() => {});
              }
              factsWritten++;
              log.info(
                "post",
                `→ ${layer}/${category}: ${content.slice(0, 100)}`,
                { meta: { factId: id, layer, category } },
              );
              result = JSON.stringify({ ok: true, id });
            } catch (err) {
              const em = err instanceof Error ? err.message : String(err);
              log.warn("post", `memory_write failed: ${em}`);
              result = JSON.stringify({ ok: false, error: em });
            }
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

    log.info(
      "post",
      `Extraction done in ${Date.now() - extractionStart}ms: ${factsWritten} facts written, ${searchCalls} searches, ${steps} tool calls`,
      { meta: { factsWritten, searchCalls, steps } },
    );
  } catch (err) {
    log.error(
      "post",
      `Agentic extraction failed: ${err instanceof Error ? err.message : err}`,
    );
  }
}

export async function postProcessFromStream(
  memory: MemoryDB,
  router: ModelRouter,
  rag: RAGPipeline,
  stream: ReadableStream<Uint8Array>,
  userMessage: string,
  requestId: string,
  sessionId: string,
  model: string,
  log: RequestLogger,
): Promise<void> {
  const decoder = new TextDecoder();
  const contentChunks: string[] = [];
  const reasoningChunks: string[] = [];

  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      for (const line of text.split("\n")) {
        const delta = parseSSEChunk(line);
        if (!delta) continue;
        if (delta.content) contentChunks.push(delta.content);
        if (delta.reasoning_content) reasoningChunks.push(delta.reasoning_content);
      }
    }
  } finally {
    reader.releaseLock();
  }

  const fullResponse = contentChunks.join("");
  const fullReasoning = reasoningChunks.join("");

  log.info(
    "post",
    `Stream captured: ${fullResponse.length} chars content, ${fullReasoning.length} chars reasoning`,
    { model },
  );

  if (fullResponse || fullReasoning) {
    await postProcess(
      memory,
      router,
      rag,
      userMessage,
      fullResponse,
      requestId,
      sessionId,
      model,
      undefined,
      fullReasoning || undefined,
    );
  }
}

