import { randomUUID } from "crypto";
import type { MemoryDB } from "../db";
import type { ModelRouter } from "../lib/model-router";
import type { Metrics } from "../lib/metrics";
import type { RAGPipeline, RAGResult } from "../rag";
import type { Message, ChatResponse } from "../providers/types";
import type { ArbitrationRoom } from "./arbitration-room";
import { logger } from "../lib/logger";
import { getPersonaBio } from "../lib/personas";

// ─── Hippocampus System Prompt ───────────────────────────

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

// ─── Types ───────────────────────────────────────────────

export interface PipelineRequest {
  /** Virtual model name from client (e.g. "coder", "teamlead") */
  model: string;
  messages: Message[];
  /** If true, stream the main response */
  stream?: boolean;
  /** Explicit session ID (for multi-turn awareness) */
  sessionId?: string;
  /** Pass-through params */
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  tools?: any[];
  tool_choice?: any;
}

export interface PipelineResult {
  requestId: string;
  sessionId: string;
  /** Non-streaming: the full response */
  response?: ChatResponse;
  /** Streaming: the SSE stream */
  stream?: ReadableStream<Uint8Array>;
}

interface PreProcessingOutput {
  executiveSummary: string;
  ragResults: RAGResult[];
  focusEntries: Record<string, string>;
  sharedMemory: import("../db").SharedRow[];
  rawMemoryBlock: string;
}

// ─── Pipeline ────────────────────────────────────────────

export class AgentPipeline {
  private metrics: Metrics | null = null;
  private room: ArbitrationRoom | null = null;

  constructor(
    private memory: MemoryDB,
    private router: ModelRouter,
    private rag: RAGPipeline,
  ) {}

  setMetrics(metrics: Metrics): void {
    this.metrics = metrics;
  }

  setArbitrationRoom(room: ArbitrationRoom): void {
    this.room = room;
  }

  /**
   * Full 3-stage pipeline: pre → main → post.
   * Post-processing runs asynchronously (fire-and-forget).
   */
  async execute(req: PipelineRequest): Promise<PipelineResult> {
    const requestId = randomUUID();
    const sessionId = req.sessionId || randomUUID();
    const userMessage = this.extractLastUserMessage(req.messages);
    const log = logger.forRequest(requestId, sessionId);

    log.info(
      "pipeline",
      `▶ New request: model=${req.model} stream=${!!req.stream} msgs=${req.messages.length}`,
      {
        model: req.model,
        meta: { userMessage: userMessage.slice(0, 200) },
      },
    );

    // ─── Decide which stages to run ──────────────────────
    const isFirstMessage = this.isFirstMessage(req.messages);

    log.debug("pipeline", `Decision: first=${isFirstMessage}`);

    // ─── Streaming: wrap entire pipeline in progress stream ─
    if (req.stream) {
      const stream = this.createPipelineStream(
        req,
        requestId,
        sessionId,
        log,
        userMessage,
        isFirstMessage,
      );
      return { requestId, sessionId, stream };
    }

    // ─── Stage 1: Pre-processing (non-streaming) ─────────
    let enrichedSystemPrompt: string | undefined;

    if (isFirstMessage) {
      const preStart = Date.now();
      log.info("pre", "Starting pre-processing: RAG + focus fetch");
      const pre = await this.preProcess(userMessage, sessionId);
      enrichedSystemPrompt = this.buildSystemPrompt(pre, req.model);
      const preDur = Date.now() - preStart;
      log.info(
        "pre",
        `Pre-processing complete: ${pre.ragResults.length} RAG results, summary ${pre.executiveSummary.length} chars`,
        {
          durationMs: preDur,
          meta: {
            ragCount: pre.ragResults.length,
            focusKeys: Object.keys(pre.focusEntries),
            summaryPreview: pre.executiveSummary.slice(0, 200),
          },
        },
      );
      this.metrics?.record({
        model: "flash",
        priority: "normal",
        stage: "pre",
        latencyMs: Date.now() - preStart,
        tokensIn: 0,
        tokensOut: 0,
        status: "ok",
      });
    } else {
      // Continuation — still inject identity + focus + shared (no RAG)
      const focus = this.memory.getAllFocus();
      const shared = this.memory.getAllShared();
      log.debug(
        "pre",
        `Continuation: injecting identity + ${Object.keys(focus).length} focus keys + ${shared.length} shared facts`,
      );
      enrichedSystemPrompt = this.buildSystemPrompt(
        {
          executiveSummary: "",
          ragResults: [],
          focusEntries: focus,
          sharedMemory: shared,
          rawMemoryBlock: "",
        },
        req.model,
      );
    }

    // ─── Stage 2: Main execution ─────────────────────────

    // Check if arbitration room should handle this (non-streaming only)
    if (!req.stream && this.room) {
      const roomConfig = this.room.classify(userMessage);
      if (roomConfig) {
        log.info(
          "main",
          `Arbitration Room activated: ${roomConfig.agents.join(",")}`,
          { model: "room" },
        );
        const mainStart = Date.now();
        const result = await this.room.run(
          userMessage,
          enrichedSystemPrompt || "",
          roomConfig,
        );
        log.info(
          "main",
          `Room synthesis complete: ${result.synthesis.length} chars`,
          {
            model: "teamlead",
            durationMs: Date.now() - mainStart,
          },
        );
        this.metrics?.record({
          model: "room",
          priority: "critical",
          stage: "main",
          latencyMs: Date.now() - mainStart,
          tokensIn: 0,
          tokensOut: 0,
          status: "ok",
        });

        const response: ChatResponse = {
          id: `chatcmpl-${requestId}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "teamlead",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: result.synthesis },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };

        // Post-process
        this.postProcess(
          userMessage,
          result.synthesis,
          requestId,
          sessionId,
          "teamlead",
        ).catch((err) => {
          log.error(
            "post",
            `Post-processing failed: ${err instanceof Error ? err.message : err}`,
          );
        });

        return { requestId, sessionId, response };
      }
    }

    const messages = this.injectSystemPrompt(
      req.messages,
      enrichedSystemPrompt,
    );
    const params = {
      messages,
      temperature: req.temperature,
      max_tokens: req.max_tokens,
      top_p: req.top_p,
      tools: req.tools,
      tool_choice: req.tool_choice,
    };

    log.info("main", `Non-stream call to ${req.model}`, { model: req.model });
    const mainStart = Date.now();
    const response = await this.router.chat(req.model, params);
    const mainDur = Date.now() - mainStart;
    const assistantMessage = response.choices[0]?.message?.content || "";
    const reasoningContent =
      (response.choices[0]?.message as any)?.reasoning_content || "";
    log.info(
      "main",
      `Response: ${assistantMessage.length} chars content, ${reasoningContent.length} chars reasoning`,
      {
        model: req.model,
        durationMs: mainDur,
        tokensIn: response.usage?.prompt_tokens || 0,
        tokensOut: response.usage?.completion_tokens || 0,
      },
    );
    if (reasoningContent) {
      log.debug("reasoning", `Thinking: ${reasoningContent.slice(0, 500)}`, {
        model: req.model,
      });
    }
    this.metrics?.record({
      model: req.model,
      priority: "critical",
      stage: "main",
      latencyMs: mainDur,
      tokensIn: response.usage?.prompt_tokens || 0,
      tokensOut: response.usage?.completion_tokens || 0,
      status: "ok",
    });

    // Fire-and-forget post-processing
    this.postProcess(
      userMessage,
      assistantMessage,
      requestId,
      sessionId,
      req.model,
      response.usage,
      reasoningContent || undefined,
    ).catch((err) => {
      log.error(
        "post",
        `Post-processing failed: ${err instanceof Error ? err.message : err}`,
      );
    });

    log.info("pipeline", `◀ Request complete`, {
      model: req.model,
      durationMs: mainDur,
    });
    return { requestId, sessionId, response };
  }

  // ─── Streaming pipeline with progress events ──────────

  private createPipelineStream(
    req: PipelineRequest,
    requestId: string,
    sessionId: string,
    log: import("../lib/logger").RequestLogger,
    userMessage: string,
    isFirstMessage: boolean,
  ): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const self = this;

    const makeProgressChunk = (text: string): Uint8Array => {
      const chunk = {
        id: `chatcmpl-${requestId}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: req.model,
        choices: [
          {
            index: 0,
            delta: { reasoning_content: text },
            finish_reason: null,
          },
        ],
      };
      return encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`);
    };

    return new ReadableStream({
      async start(controller) {
        try {
          const emit = (text: string) =>
            controller.enqueue(makeProgressChunk(text));
          let enrichedSystemPrompt: string | undefined;

          if (isFirstMessage) {
            const preStart = Date.now();
            log.info("pre", "Starting pre-processing: RAG + focus fetch");
            const pre = await self.preProcess(userMessage, sessionId, emit);
            enrichedSystemPrompt = self.buildSystemPrompt(pre, req.model);
            const preDur = Date.now() - preStart;
            log.info(
              "pre",
              `Pre-processing complete: ${pre.ragResults.length} RAG results, summary ${pre.executiveSummary.length} chars`,
              {
                durationMs: preDur,
                meta: {
                  ragCount: pre.ragResults.length,
                  focusKeys: Object.keys(pre.focusEntries),
                  summaryPreview: pre.executiveSummary.slice(0, 200),
                },
              },
            );
            self.metrics?.record({
              model: "flash",
              priority: "normal",
              stage: "pre",
              latencyMs: preDur,
              tokensIn: 0,
              tokensOut: 0,
              status: "ok",
            });
          } else {
            emit("📋 Загрузка директив...\n");
            const focus = self.memory.getAllFocus();
            const shared = self.memory.getAllShared();
            log.debug(
              "pre",
              `Continuation: injecting identity + ${Object.keys(focus).length} focus keys + ${shared.length} shared facts`,
            );
            enrichedSystemPrompt = self.buildSystemPrompt(
              {
                executiveSummary: "",
                ragResults: [],
                focusEntries: focus,
                sharedMemory: shared,
                rawMemoryBlock: "",
              },
              req.model,
            );
          }

          emit(`💬 Отправка запроса к ${req.model}...\n`);

          const messages = self.injectSystemPrompt(
            req.messages,
            enrichedSystemPrompt,
          );
          const params = {
            messages,
            temperature: req.temperature,
            max_tokens: req.max_tokens,
            top_p: req.top_p,
            tools: req.tools,
            tool_choice: req.tool_choice,
          };

          log.info("main", `Streaming via ${req.model}`, {
            model: req.model,
          });
          const modelStream = await self.router.chatStream(req.model, params);
          const [pipeStream, captureStream] = modelStream.tee();

          // Fire-and-forget post-processing
          self
            .postProcessFromStream(
              captureStream,
              userMessage,
              requestId,
              sessionId,
              req.model,
              log,
            )
            .catch((err) => {
              log.error(
                "post",
                `Stream post-processing failed: ${err instanceof Error ? err.message : err}`,
              );
            });

          // Pipe model stream through
          const reader = pipeStream.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }

          controller.close();
        } catch (err) {
          log.error(
            "pipeline",
            `Pipeline stream error: ${err instanceof Error ? err.message : err}`,
          );
          const errMsg = err instanceof Error ? err.message : String(err);
          controller.enqueue(makeProgressChunk(`\n❌ Ошибка: ${errMsg}\n`));
          controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
          controller.close();
        }
      },
    });
  }

  // ─── Stage 1: Pre-processing ──────────────────────────

  private async preProcess(
    userMessage: string,
    sessionId: string,
    onProgress?: (msg: string) => void,
  ): Promise<PreProcessingOutput> {
    // Parallel: RAG search + focus fetch + shared memory
    onProgress?.("🔍 Поиск в памяти (RAG + FTS + shared)...\n");
    const [ragResults, focusEntries, sharedMemory] = await Promise.all([
      this.rag
        .search({
          query: userMessage,
          rerankTopN: 5,
        })
        .catch(() => [] as RAGResult[]),
      Promise.resolve(this.memory.getAllFocus()),
      Promise.resolve(this.memory.getAllShared()),
    ]);

    onProgress?.(
      `📚 Найдено ${ragResults.length} фрагментов, ${Object.keys(focusEntries).length} директив, ${sharedMemory.length} фактов\n`,
    );

    // Build raw memory block (always available, even without flash summary)
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

    // If nothing found at all, return minimal context
    if (ragResults.length === 0 && sharedMemory.length === 0) {
      return {
        executiveSummary: "",
        ragResults: [],
        focusEntries,
        sharedMemory: [],
        rawMemoryBlock: "",
      };
    }

    // Build context block for flash hippocampus
    onProgress?.("🧠 Гиппокамп собирает Executive Summary...\n");
    const contextBlock = rawMemoryBlock;

    // Ask flash (hippocampus) to build executive summary — 1 RPM
    const summaryResponse = await this.router.chat(
      "flash",
      {
        messages: [
          {
            role: "system",
            content: getHippocampusPrompt(),
          },
          {
            role: "user",
            content: `User message: "${userMessage}"\n\nMemory dump:\n${contextBlock}`,
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

  // ─── Stage 3: Post-processing ─────────────────────────

  private async postProcess(
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

    // 1. Log the exchange to Layer 4 (always — zero RPM cost)
    this.memory.appendLog(requestId, sessionId, model, "user", userMessage);
    this.memory.appendLog(
      requestId,
      sessionId,
      model,
      "assistant",
      assistantMessage,
      usage?.completion_tokens,
    );

    // 1b. Log reasoning/thinking if present
    if (reasoning && reasoning.length > 0) {
      this.memory.appendLog(
        requestId,
        sessionId,
        model,
        "reasoning",
        reasoning,
      );
      log.info("post", `Reasoning logged: ${reasoning.length} chars`, {
        model,
      });
    }

    // 2. Extract knowledge delta via flash — 1 RPM
    // Use reasoning as fallback if content is empty (some models return only reasoning_content)
    const textForExtraction = assistantMessage || reasoning || "";
    if (textForExtraction.length < 100) {
      log.debug("post", "Skipping knowledge extraction: response too short");
      return;
    }

    try {
      log.info("post", "Extracting knowledge delta via flash", {
        model: "flash",
      });
      const deltaStart = Date.now();
      const deltaResponse = await this.router.chat(
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
              content: `User: ${userMessage}\n\nAssistant: ${textForExtraction.substring(0, 2000)}`,
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
      const delta = this.parseJson(raw);
      log.info("post", `Knowledge extraction: ${Date.now() - deltaStart}ms`, {
        durationMs: Date.now() - deltaStart,
        meta: { raw: raw.slice(0, 300) },
      });

      if (!delta || delta.skip || !Array.isArray(delta.facts)) {
        log.debug("post", "No new facts extracted");
        return;
      }

      // 3. Write extracted facts to Layer 2 (context) with auto-embed via RAG
      for (const fact of delta.facts.slice(0, 3)) {
        if (!fact.content) continue;
        const id = randomUUID();
        this.memory.insertContext(
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
        // Auto-embed (fire-and-forget)
        this.rag.indexEntry(id, "context", fact.content).catch(() => {});
      }
    } catch (err) {
      log.error(
        "post",
        `Knowledge extraction failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /**
   * Post-process from a tee'd stream by consuming all chunks.
   */
  private async postProcessFromStream(
    stream: ReadableStream<Uint8Array>,
    userMessage: string,
    requestId: string,
    sessionId: string,
    model: string,
    log: import("../lib/logger").RequestLogger,
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
        // Parse SSE data lines to extract content and reasoning
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
            // Malformed chunk, skip
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
      {
        model,
      },
    );

    if (fullResponse || fullReasoning) {
      await this.postProcess(
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

  // ─── Helpers ───────────────────────────────────────────

  private extractLastUserMessage(messages: Message[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user" && messages[i].content) {
        return messages[i].content!;
      }
    }
    return "";
  }

  /**
   * Heuristic: first message = no prior assistant response in history.
   */
  private isFirstMessage(messages: Message[]): boolean {
    return !messages.some((m) => m.role === "assistant");
  }

  private buildSystemPrompt(pre: PreProcessingOutput, model: string): string {
    const parts: string[] = [];

    // Persona identity (always first)
    parts.push(getPersonaBio(model));

    // Layer 1: Focus / Directives
    if (Object.keys(pre.focusEntries).length > 0) {
      parts.push("\n## Текущие директивы (Layer 1: Focus)");
      for (const [key, value] of Object.entries(pre.focusEntries)) {
        parts.push(`- **${key}:** ${value}`);
      }
    }

    // Shared memory: facts about the user (always loaded directly)
    if (pre.sharedMemory && pre.sharedMemory.length > 0) {
      parts.push("\n## Общая память (факты о пользователе)");
      for (const entry of pre.sharedMemory) {
        parts.push(`- [${entry.category}] ${entry.content}`);
      }
    }

    // Executive Summary from hippocampus (flash)
    if (pre.executiveSummary) {
      parts.push("\n## Executive Summary (собрано гиппокампом)");
      parts.push(pre.executiveSummary);
    }

    // Raw memory block — full unprocessed context for transparency
    if (pre.rawMemoryBlock) {
      parts.push("\n## Raw Memory Dump (полный контекст из памяти)");
      parts.push(pre.rawMemoryBlock);
    }

    return parts.join("\n");
  }

  /**
   * Inject enriched system prompt: prepend to existing system message,
   * or add a new one at position [0].
   */
  private injectSystemPrompt(
    messages: Message[],
    systemAddition?: string,
  ): Message[] {
    if (!systemAddition) return messages;

    const result = [...messages];
    const sysIdx = result.findIndex((m) => m.role === "system");

    if (sysIdx >= 0) {
      // Prepend context before existing system prompt
      result[sysIdx] = {
        ...result[sysIdx],
        content: systemAddition + "\n\n" + (result[sysIdx].content || ""),
      };
    } else {
      result.unshift({ role: "system", content: systemAddition });
    }

    return result;
  }

  private parseJson(text: string): any {
    // Try to extract JSON from markdown code blocks or raw text
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const raw = jsonMatch ? jsonMatch[1].trim() : text.trim();
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
}
