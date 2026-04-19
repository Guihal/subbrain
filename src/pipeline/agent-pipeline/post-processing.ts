/**
 * Stage 3: Post-processing — knowledge delta extraction & storage.
 */
import { randomUUID } from "crypto";
import type { MemoryDB } from "../../db";
import type { ModelRouter } from "../../lib/model-router";
import type { RAGPipeline } from "../../rag";
import { logger, type RequestLogger } from "../../lib/logger";

/** Minimum response length to trigger knowledge extraction */
const MIN_EXTRACTION_LENGTH = 100;
/** Max chars sent to the extraction model */
const MAX_EXTRACTION_INPUT = 2000;
/** Max number of facts to store per exchange */
const MAX_FACTS_PER_EXCHANGE = 3;

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
): Promise<void> {
  const log = logger.forRequest(requestId, sessionId);
  log.info(
    "post",
    `Post-processing: user=${userMessage.length}ch assistant=${assistantMessage.length}ch`,
    { model },
  );

  // 1. Log the exchange to Layer 4
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
    log.info("post", `Reasoning logged: ${reasoning.length} chars`, { model });
  }

  // 2. Extract knowledge delta via flash
  const textForExtraction = assistantMessage || reasoning || "";
  if (textForExtraction.length < MIN_EXTRACTION_LENGTH) {
    log.debug("post", "Skipping knowledge extraction: response too short");
    return;
  }

  try {
    log.info("post", "Extracting knowledge delta via flash", {
      model: "flash",
    });
    const deltaStart = Date.now();
    const deltaResponse = await router.chat(
      "flash",
      {
        messages: [
          {
            role: "system",
            content: `You are a knowledge extractor. Given a user-assistant exchange, identify NEW facts, decisions, or insights worth remembering. Output JSON:
{"facts": [{"content": "...", "tags": "comma,separated", "category": "decision|fact|insight|preference"}], "skip": false}
If nothing new, return {"facts": [], "skip": true}. Be selective — only genuine new knowledge.`,
          },
          {
            role: "user",
            content: `User: ${userMessage}\n\nAssistant: ${textForExtraction.substring(0, MAX_EXTRACTION_INPUT)}`,
          },
        ],
        max_tokens: 512,
        temperature: 0.2,
      },
      "low",
    );

    const raw =
      deltaResponse.choices[0]?.message?.content ||
      (deltaResponse.choices[0]?.message as any)?.reasoning_content ||
      "";
    const delta = parseJson(raw);
    log.info("post", `Knowledge extraction: ${Date.now() - deltaStart}ms`, {
      durationMs: Date.now() - deltaStart,
      meta: { raw: raw.slice(0, 300) },
    });

    if (!delta || delta.skip || !Array.isArray(delta.facts)) {
      log.debug("post", "No new facts extracted");
      return;
    }

    // 3. Write extracted facts to Layer 2 (context)
    for (const fact of delta.facts.slice(0, MAX_FACTS_PER_EXCHANGE)) {
      if (!fact.content) continue;
      const id = randomUUID();
      memory.insertContext(
        id,
        fact.category || "fact",
        fact.content,
        fact.tags || "",
        [requestId],
      );
      log.info(
        "post",
        `New fact stored: [${fact.category}] ${fact.content.slice(0, 100)}`,
        {
          meta: { factId: id, tags: fact.tags },
        },
      );
      rag.indexEntry(id, "context", fact.content).catch(() => {});
    }
  } catch (err) {
    log.error(
      "post",
      `Knowledge extraction failed: ${err instanceof Error ? err.message : err}`,
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
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;
        try {
          const chunk = JSON.parse(data);
          const delta = chunk.choices?.[0]?.delta;
          if (delta?.content) contentChunks.push(delta.content);
          if (delta?.reasoning_content)
            reasoningChunks.push(delta.reasoning_content);
        } catch {
          // Malformed chunk
        }
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

function parseJson(text: string): any {
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = jsonMatch ? jsonMatch[1].trim() : text.trim();
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
