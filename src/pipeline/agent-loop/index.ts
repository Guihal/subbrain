/**
 * Autonomous Agent Loop — agentic mode where the model can call tools
 * and reason iteratively up to MAX_STEPS to avoid hallucination loops.
 *
 * Flow:
 * 1. Build system prompt with full memory context
 * 2. Send to model with tools
 * 3. If model returns tool_calls → execute tools → append results → loop
 * 4. If model returns content (no tool_calls) → done
 * 5. Hard cap at MAX_STEPS iterations
 */
import { randomUUID } from "crypto";
import type { MemoryDB } from "../../db";
import type { ModelRouter } from "../../lib/model-router";
import type { RAGPipeline } from "../../rag";
import type { ToolExecutor } from "../../mcp/executor";
import type { Message, Tool } from "../../providers/types";
import type { Metrics } from "../../lib/metrics";
import type { ArbitrationRoom } from "../arbitration-room";
import { logger } from "../../lib/logger";

import {
  MAX_STEPS,
  MAX_OUTPUT_TOKENS,
  MAX_CONTEXT_TOKENS,
  AGENT_MODEL,
  estimateTokens,
  type AgentLoopRequest,
  type AgentLoopStep,
  type AgentLoopResult,
} from "./types";
import { DynamicToolRegistry, type DynamicToolDef } from "./dynamic-tools";
import { AGENT_TOOLS } from "./tool-defs";
import { executeAgentTool, type ToolRunnerDeps } from "./tool-runner";
import { buildAgentSystemPrompt } from "./system-prompt";

// Re-export public API
export { DynamicToolRegistry } from "./dynamic-tools";
export type { DynamicToolDef } from "./dynamic-tools";
export type { AgentLoopRequest, AgentLoopStep, AgentLoopResult } from "./types";

export class AgentLoop {
  private metrics: Metrics | null = null;
  private room: ArbitrationRoom | null = null;
  private dynamicTools = new DynamicToolRegistry();

  constructor(
    private memory: MemoryDB,
    private router: ModelRouter,
    private rag: RAGPipeline,
    private tools: ToolExecutor,
  ) {
    this.loadPersistedTools();
  }

  private loadPersistedTools(): void {
    try {
      const rows = this.memory.db
        .query(
          "SELECT content FROM agent_memory WHERE agent_id = 'dynamic_tools' ORDER BY updated_at DESC LIMIT 1",
        )
        .get() as { content: string } | null;
      if (rows?.content) {
        const defs: DynamicToolDef[] = JSON.parse(rows.content);
        this.dynamicTools.load(defs);
        logger.info(
          "agent-loop",
          `Loaded ${defs.length} persisted dynamic tools`,
        );
      }
    } catch {
      // No persisted tools or parse error
    }
  }

  private persistDynamicTools(): void {
    const serialized = JSON.stringify(this.dynamicTools.serialize());
    const existing = this.memory.db
      .query(
        "SELECT id FROM agent_memory WHERE agent_id = 'dynamic_tools' LIMIT 1",
      )
      .get() as { id: string } | null;
    if (existing) {
      this.memory.db.run(
        "UPDATE agent_memory SET content = ?, updated_at = unixepoch() WHERE id = ?",
        [serialized, existing.id],
      );
    } else {
      this.memory.insertAgentMemory(
        randomUUID(),
        "dynamic_tools",
        serialized,
        "dynamic,tools,registry",
      );
    }
  }

  private getAllTools(): Tool[] {
    return [...AGENT_TOOLS, ...this.dynamicTools.toToolDefs()];
  }

  private getToolRunnerDeps(): ToolRunnerDeps {
    return {
      tools: this.tools,
      router: this.router,
      room: this.room,
      dynamicTools: this.dynamicTools,
      persistDynamicTools: () => this.persistDynamicTools(),
    };
  }

  setMetrics(metrics: Metrics): void {
    this.metrics = metrics;
  }

  setRoom(room: ArbitrationRoom): void {
    this.room = room;
  }

  // ─── Synchronous run ─────────────────────────────────

  async run(req: AgentLoopRequest): Promise<AgentLoopResult> {
    const requestId = randomUUID();
    const sessionId = req.sessionId || randomUUID();
    const model = req.model || AGENT_MODEL;
    const maxSteps = Math.min(req.maxSteps || MAX_STEPS, MAX_STEPS);
    const priority = req.priority || "critical";
    const log = logger.forRequest(requestId, sessionId);
    const deps = this.getToolRunnerDeps();

    log.info(
      "agent-loop",
      `▶ Starting autonomous loop: "${req.task.slice(0, 100)}"`,
      {
        model,
        meta: { maxSteps, priority },
      },
    );

    const systemPrompt = await buildAgentSystemPrompt(
      this.memory,
      this.rag,
      req.task,
      model,
      this.router,
    );
    const messages: Message[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: req.task },
    ];

    const steps: AgentLoopStep[] = [];
    let finalAnswer = "";
    let stoppedReason: AgentLoopResult["stoppedReason"] = "max_steps";

    for (let step = 1; step <= maxSteps; step++) {
      log.info("agent-loop", `Step ${step}/${maxSteps}`, { model });

      // Budget note injected as user message to avoid "system after tool" error
      const estTokens = estimateTokens(messages);
      const budgetNote: Message = {
        role: "user",
        content: `[Системная метка: Шаг ${step}/${maxSteps} | Осталось вызовов: ${maxSteps - step + 1} | Контекст: ~${estTokens}/${MAX_CONTEXT_TOKENS} токенов]`,
      };
      messages.push(budgetNote);

      const allTools = this.getAllTools();

      const response = await this.router.chat(
        model,
        {
          messages,
          tools: allTools,
          tool_choice: "auto",
          max_tokens: MAX_OUTPUT_TOKENS,
          temperature: 0.7,
        },
        priority,
      );

      messages.pop(); // Remove temporary budget note

      const choice = response.choices[0];
      if (!choice) {
        log.error("agent-loop", "No choice in response");
        stoppedReason = "error";
        finalAnswer = "Error: empty response from model";
        break;
      }

      const msg = choice.message;
      const reasoning = (msg as any).reasoning_content || "";

      // Case 1: Model returns tool_calls
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        steps.push({
          step,
          role: "assistant",
          content: msg.content || reasoning || null,
          toolCalls: msg.tool_calls,
        });

        messages.push({
          role: "assistant",
          content: msg.content,
          tool_calls: msg.tool_calls,
        });

        for (const tc of msg.tool_calls) {
          const toolResult = await executeAgentTool(tc, deps, log);

          if (tc.function.name === "done") {
            try {
              const args = JSON.parse(tc.function.arguments);
              finalAnswer = args.summary || toolResult;
            } catch {
              finalAnswer = toolResult;
            }
            stoppedReason = "done";
          }

          steps.push({
            step,
            role: "tool",
            content: toolResult,
            toolName: tc.function.name,
            toolResult,
          });

          messages.push({
            role: "tool",
            content: toolResult,
            tool_call_id: tc.id,
          });
        }

        if (stoppedReason === "done") break;
        continue;
      }

      // Case 2: Plain content (no tool calls) → finished
      const content = msg.content || reasoning || "";
      if (content) {
        finalAnswer = content;
        stoppedReason = "content_response";
        steps.push({ step, role: "assistant", content });
        break;
      }

      // Case 3: Empty response
      log.warn("agent-loop", `Step ${step}: empty response, stopping`);
      stoppedReason = "error";
      finalAnswer = "Agent produced no output";
      break;
    }

    log.info(
      "agent-loop",
      `◀ Loop finished: ${steps.length} steps, reason=${stoppedReason}`,
      {
        model,
        meta: { steps: steps.length, reason: stoppedReason },
      },
    );

    // Store in Layer 4
    this.memory.appendLog(requestId, sessionId, model, "user", req.task);
    this.memory.appendLog(
      requestId,
      sessionId,
      model,
      "assistant",
      `[Autonomous loop: ${steps.length} steps, reason: ${stoppedReason}]\n\n${finalAnswer}`,
    );

    // Persist to chats (INSERT OR IGNORE to avoid UNIQUE constraint errors)
    this.persistToChat(sessionId, requestId, model, req.task, finalAnswer);

    return {
      requestId,
      sessionId,
      steps,
      finalAnswer,
      totalSteps: steps.length,
      stoppedReason,
    };
  }

  // ─── Streaming run ───────────────────────────────────

  createStream(req: AgentLoopRequest): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const self = this;

    return new ReadableStream({
      async start(controller) {
        const emit = (event: string, data: unknown) => {
          controller.enqueue(
            encoder.encode(
              `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
            ),
          );
        };

        try {
          const requestId = randomUUID();
          const sessionId = req.sessionId || randomUUID();
          const model = req.model || AGENT_MODEL;
          const maxSteps = Math.min(req.maxSteps || MAX_STEPS, MAX_STEPS);
          const priority = req.priority || "critical";
          const log = logger.forRequest(requestId, sessionId);
          const deps = self.getToolRunnerDeps();

          emit("start", { requestId, sessionId, model, maxSteps });

          const systemPrompt = await buildAgentSystemPrompt(
            self.memory,
            self.rag,
            req.task,
            model,
            self.router,
          );
          const messages: Message[] = [
            { role: "system", content: systemPrompt },
            { role: "user", content: req.task },
          ];

          for (let step = 1; step <= maxSteps; step++) {
            emit("step", { step, maxSteps, status: "thinking" });

            // Budget note as user message to avoid "system after tool" error
            const estTokens = estimateTokens(messages);
            const budgetNote: Message = {
              role: "user",
              content: `[Системная метка: Шаг ${step}/${maxSteps} | Осталось вызовов: ${maxSteps - step + 1} | Контекст: ~${estTokens}/${MAX_CONTEXT_TOKENS} токенов]`,
            };
            messages.push(budgetNote);

            const allTools = self.getAllTools();

            const response = await self.router.chat(
              model,
              {
                messages,
                tools: allTools,
                tool_choice: "auto",
                max_tokens: MAX_OUTPUT_TOKENS,
                temperature: 0.7,
              },
              priority,
            );

            messages.pop(); // Remove budget note

            const choice = response.choices[0];
            if (!choice) {
              emit("error", { step, error: "Empty response" });
              break;
            }

            const msg = choice.message;
            const reasoning = (msg as any).reasoning_content || "";

            // Emit reasoning if present
            if (reasoning) {
              emit("thinking", { step, content: reasoning });
            }

            if (msg.tool_calls && msg.tool_calls.length > 0) {
              for (const tc of msg.tool_calls) {
                emit("tool_call", {
                  step,
                  name: tc.function.name,
                  args: tc.function.arguments,
                });

                const toolResult = await executeAgentTool(tc, deps, log);

                emit("tool_result", {
                  step,
                  name: tc.function.name,
                  result: toolResult.slice(0, 2000),
                });

                if (tc.function.name === "done") {
                  const summary =
                    (() => {
                      try {
                        return JSON.parse(tc.function.arguments).summary;
                      } catch {
                        return toolResult;
                      }
                    })() || toolResult;

                  emit("done", { step, summary });

                  self.memory.appendLog(
                    requestId,
                    sessionId,
                    model,
                    "user",
                    req.task,
                  );
                  self.memory.appendLog(
                    requestId,
                    sessionId,
                    model,
                    "assistant",
                    `[Autonomous: ${step} steps] ${summary}`,
                  );
                  self.persistToChat(
                    sessionId,
                    requestId,
                    model,
                    req.task,
                    summary,
                  );

                  controller.enqueue(
                    encoder.encode("event: end\ndata: {}\n\n"),
                  );
                  controller.close();
                  return;
                }

                messages.push({
                  role: "assistant",
                  content: msg.content,
                  tool_calls: msg.tool_calls,
                });
                messages.push({
                  role: "tool",
                  content: toolResult,
                  tool_call_id: tc.id,
                });
              }
              continue;
            }

            // Plain content response
            const content = msg.content || reasoning || "";
            if (content) {
              emit("response", { step, content });
              self.memory.appendLog(
                requestId,
                sessionId,
                model,
                "user",
                req.task,
              );
              self.memory.appendLog(
                requestId,
                sessionId,
                model,
                "assistant",
                content,
              );
              self.persistToChat(
                sessionId,
                requestId,
                model,
                req.task,
                content,
              );
              break;
            }

            emit("error", { step, error: "Empty response" });
            break;
          }

          controller.enqueue(encoder.encode("event: end\ndata: {}\n\n"));
          controller.close();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          controller.enqueue(
            encoder.encode(
              `event: error\ndata: ${JSON.stringify({ error: msg })}\n\n`,
            ),
          );
          controller.enqueue(encoder.encode("event: end\ndata: {}\n\n"));
          controller.close();
        }
      },
    });
  }

  // ─── Chat persistence helper ──────────────────────────

  private persistToChat(
    sessionId: string,
    requestId: string,
    model: string,
    task: string,
    answer: string,
  ): void {
    const chatId = sessionId || `auto-${requestId}`;
    const chatSource = sessionId ? "web" : "autonomous";

    // Chat may already exist (created by autonomous route upfront)
    const existing = this.memory.getChat(chatId);
    if (!existing) {
      try {
        this.memory.createChat(chatId, task.slice(0, 80), model, chatSource);
      } catch (err) {
        if (
          !String(err instanceof Error ? err.message : err).includes("UNIQUE")
        )
          throw err;
      }
      this.memory.appendChatMessage(chatId, "user", task);
    }

    if (answer) {
      this.memory.appendChatMessage(chatId, "assistant", answer, {
        model,
        requestId,
      });
    }
  }
}
