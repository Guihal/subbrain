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
import type { MemoryDB, SharedRow } from "../db";
import type { ModelRouter } from "../lib/model-router";
import type { RAGPipeline, RAGResult } from "../rag";
import type { ToolExecutor } from "../mcp/executor";
import type { Message, Tool, ToolCall, ChatResponse } from "../providers/types";
import type { Metrics } from "../lib/metrics";
import type { ArbitrationRoom } from "./arbitration-room";
import type { Priority } from "../lib/model-map";
import { logger } from "../lib/logger";
import { getPersonaBio } from "../lib/personas";

// ─── Constants ───────────────────────────────────────────

const MAX_STEPS = 20;
const MAX_OUTPUT_TOKENS = 128_000;
const MAX_CONTEXT_TOKENS = 128_000; // approximate budget tracking
const AGENT_MODEL = "teamlead"; // Лид — самая умная модель, ведёт автономный цикл

/** Human-readable current date for model awareness */
function getCurrentDate(): string {
  return new Date().toLocaleDateString("ru-RU", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/** Rough token estimate for context budget tracking */
function estimateTokens(messages: Message[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

// ─── Dynamic Tool Registry ───────────────────────────────

const MAX_DYNAMIC_TOOLS = 10;

export interface DynamicToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** What model to send the prompt to */
  model: string;
  /** System prompt template. {{input}} gets replaced with caller's input */
  promptTemplate: string;
  /** When this tool was created (ISO) */
  createdAt: string;
}

/**
 * In-memory registry of tools created by the agent during a session.
 * Persisted to agent_memory between sessions.
 */
export class DynamicToolRegistry {
  private tools = new Map<string, DynamicToolDef>();

  /** Reserved names that cannot be overridden */
  private static RESERVED = new Set([
    "memory_search",
    "memory_write",
    "rag_search",
    "think",
    "done",
    "consult_specialists",
    "create_tool",
    "list_tools",
  ]);

  register(def: DynamicToolDef): { success: boolean; error?: string } {
    if (DynamicToolRegistry.RESERVED.has(def.name)) {
      return { success: false, error: `"${def.name}" is a reserved tool name` };
    }
    if (!def.name.match(/^[a-z][a-z0-9_]{1,48}$/)) {
      return {
        success: false,
        error: "Tool name must match /^[a-z][a-z0-9_]{1,48}$/",
      };
    }
    if (this.tools.size >= MAX_DYNAMIC_TOOLS && !this.tools.has(def.name)) {
      return {
        success: false,
        error: `Max ${MAX_DYNAMIC_TOOLS} dynamic tools reached. Delete one first.`,
      };
    }
    this.tools.set(def.name, def);
    return { success: true };
  }

  get(name: string): DynamicToolDef | undefined {
    return this.tools.get(name);
  }

  list(): DynamicToolDef[] {
    return [...this.tools.values()];
  }

  delete(name: string): boolean {
    return this.tools.delete(name);
  }

  /** Convert all dynamic tools to OpenAI function-calling format */
  toToolDefs(): Tool[] {
    return this.list().map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: `[Dynamic] ${t.description}`,
        parameters: t.parameters,
      },
    }));
  }

  /** Serialize for persistence */
  serialize(): DynamicToolDef[] {
    return this.list();
  }

  /** Load from persisted data */
  load(defs: DynamicToolDef[]): void {
    for (const d of defs) {
      if (!DynamicToolRegistry.RESERVED.has(d.name)) {
        this.tools.set(d.name, d);
      }
    }
  }
}

// ─── Tool Definitions (OpenAI function-calling format) ───

const AGENT_TOOLS: Tool[] = [
  {
    type: "function",
    function: {
      name: "memory_search",
      description:
        "Search across memory layers (FTS5 full-text). Returns relevant memories.",
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
      name: "memory_write",
      description:
        "Create or update a memory entry. Use to save decisions, facts, plans.",
      parameters: {
        type: "object",
        properties: {
          layer: {
            type: "string",
            enum: ["focus", "context", "shared"],
            description: "Target memory layer",
          },
          content: { type: "string", description: "Content to store" },
          title: { type: "string", description: "Title (for context layer)" },
          tags: { type: "string", description: "Comma-separated tags" },
          category: {
            type: "string",
            description: "Category (for shared layer)",
          },
          key: {
            type: "string",
            description: "Key name (required for focus layer)",
          },
        },
        required: ["layer", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "rag_search",
      description:
        "Hybrid RAG search: FTS5 + vector → rerank. Best for finding relevant context. Costs 1-2 RPM.",
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
  {
    type: "function",
    function: {
      name: "think",
      description:
        "Use this tool to think step-by-step about a complex problem before acting. Write your reasoning here. No side effects.",
      parameters: {
        type: "object",
        properties: {
          thought: {
            type: "string",
            description: "Your reasoning / chain of thought",
          },
        },
        required: ["thought"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "done",
      description:
        "Signal that you have completed the task. Include final summary for the user.",
      parameters: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description: "Final result/summary for the user",
          },
        },
        required: ["summary"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "consult_specialists",
      description:
        "Consult other AI specialists in the team. Dispatches your question to selected specialists in parallel (Coder, Critic, Generalist), collects their opinions, and synthesizes a combined answer. Use for complex decisions, code review, architecture questions, or when you need multiple expert perspectives. Costs 3-4 RPM.",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "The question or task for the specialists",
          },
          context: {
            type: "string",
            description: "Additional context / background for the question",
          },
          specialists: {
            type: "array",
            items: {
              type: "string",
              enum: ["coder", "critic", "generalist"],
            },
            description: "Which specialists to consult (default: all three)",
          },
          category: {
            type: "string",
            enum: ["code", "architecture", "review", "reasoning"],
            description:
              "Task category for weighting specialist responses (default: reasoning)",
          },
        },
        required: ["question"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_tool",
      description:
        "Create a new dynamic tool that you can use in subsequent steps. The tool will be a prompt template sent to a chosen specialist model. Use this to extend your capabilities on-the-fly for recurring sub-tasks. Max 10 dynamic tools per session.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              "Tool name (lowercase, a-z0-9_, 2-49 chars). E.g. 'analyze_code_style'",
          },
          description: {
            type: "string",
            description: "What this tool does (shown to you in future steps)",
          },
          model: {
            type: "string",
            enum: ["coder", "critic", "generalist", "flash"],
            description:
              "Which specialist model runs this tool (default: flash)",
          },
          prompt_template: {
            type: "string",
            description:
              "System prompt for the specialist. Use {{input}} as placeholder for the caller's input.",
          },
          input_description: {
            type: "string",
            description:
              "Description of the 'input' parameter (shown in tool schema)",
          },
        },
        required: ["name", "description", "prompt_template"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_tools",
      description:
        "List all currently available dynamic tools (created during this session).",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
];

// ─── Types ───────────────────────────────────────────────

export interface AgentLoopRequest {
  /** The task/goal for the agent */
  task: string;
  /** Optional: which model to use (default: teamlead) */
  model?: string;
  /** Optional: max steps override (capped at MAX_STEPS) */
  maxSteps?: number;
  /** Optional: existing session to continue */
  sessionId?: string;
  /** Optional: request priority for the rate limiter */
  priority?: Priority;
}

export interface AgentLoopStep {
  step: number;
  role: "assistant" | "tool";
  content: string | null;
  toolCalls?: ToolCall[];
  toolName?: string;
  toolResult?: string;
}

export interface AgentLoopResult {
  requestId: string;
  sessionId: string;
  steps: AgentLoopStep[];
  finalAnswer: string;
  totalSteps: number;
  stoppedReason: "done" | "max_steps" | "content_response" | "error";
}

// ─── Agent Loop ──────────────────────────────────────────

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
    // Load persisted dynamic tools from agent_memory
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
      // No persisted tools or parse error — that's fine
    }
  }

  private persistDynamicTools(): void {
    const serialized = JSON.stringify(this.dynamicTools.serialize());
    // Upsert into agent_memory
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

  /** Get all tools (static + dynamic) */
  private getAllTools(): Tool[] {
    return [...AGENT_TOOLS, ...this.dynamicTools.toToolDefs()];
  }

  setMetrics(metrics: Metrics): void {
    this.metrics = metrics;
  }

  setRoom(room: ArbitrationRoom): void {
    this.room = room;
  }

  async run(req: AgentLoopRequest): Promise<AgentLoopResult> {
    const requestId = randomUUID();
    const sessionId = req.sessionId || randomUUID();
    const model = req.model || AGENT_MODEL;
    const maxSteps = Math.min(req.maxSteps || MAX_STEPS, MAX_STEPS);
    const priority = req.priority || "critical";
    const log = logger.forRequest(requestId, sessionId);

    log.info(
      "agent-loop",
      `▶ Starting autonomous loop: "${req.task.slice(0, 100)}"`,
      {
        model,
        meta: { maxSteps, priority },
      },
    );

    // Build initial system prompt with full memory context
    const systemPrompt = await this.buildAgentSystemPrompt(req.task, model);
    const messages: Message[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: req.task },
    ];

    const steps: AgentLoopStep[] = [];
    let finalAnswer = "";
    let stoppedReason: AgentLoopResult["stoppedReason"] = "max_steps";

    // ─── Main Loop ─────────────────────────────────────
    for (let step = 1; step <= maxSteps; step++) {
      log.info("agent-loop", `Step ${step}/${maxSteps}`, { model });

      // Inject step budget info (temporary — removed after call)
      const estTokens = estimateTokens(messages);
      const budgetNote: Message = {
        role: "system",
        content: `[Шаг ${step}/${maxSteps} | Осталось вызовов: ${maxSteps - step + 1} | Контекст: ~${estTokens}/${MAX_CONTEXT_TOKENS} токенов]`,
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
        // Log assistant message with tool calls
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

        // Execute each tool call
        for (const tc of msg.tool_calls) {
          const toolResult = await this.executeTool(tc, log);

          // Check for "done" tool
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

      // Case 2: Model returns plain content (no tool calls) → finished
      const content = msg.content || reasoning || "";
      if (content) {
        finalAnswer = content;
        stoppedReason = "content_response";
        steps.push({
          step,
          role: "assistant",
          content,
        });
        break;
      }

      // Case 3: Empty response — shouldn't happen
      log.warn("agent-loop", `Step ${step}: empty response, stopping`);
      stoppedReason = "error";
      finalAnswer = "Agent produced no output";
      break;
    }

    // Log final state
    log.info(
      "agent-loop",
      `◀ Loop finished: ${steps.length} steps, reason=${stoppedReason}`,
      { model, meta: { steps: steps.length, reason: stoppedReason } },
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

    return {
      requestId,
      sessionId,
      steps,
      finalAnswer,
      totalSteps: steps.length,
      stoppedReason,
    };
  }

  /**
   * Stream the agent loop as SSE events for real-time progress.
   */
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

          emit("start", { requestId, sessionId, model, maxSteps });

          const systemPrompt = await self.buildAgentSystemPrompt(
            req.task,
            model,
          );
          const messages: Message[] = [
            { role: "system", content: systemPrompt },
            { role: "user", content: req.task },
          ];

          for (let step = 1; step <= maxSteps; step++) {
            emit("step", { step, maxSteps, status: "thinking" });

            // Inject step budget info (temporary)
            const estTokens = estimateTokens(messages);
            const budgetNote: Message = {
              role: "system",
              content: `[Шаг ${step}/${maxSteps} | Осталось вызовов: ${maxSteps - step + 1} | Контекст: ~${estTokens}/${MAX_CONTEXT_TOKENS} токенов]`,
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

            messages.pop(); // Remove temporary budget note

            const choice = response.choices[0];
            if (!choice) {
              emit("error", { step, error: "Empty response" });
              break;
            }

            const msg = choice.message;
            const reasoning = (msg as any).reasoning_content || "";

            if (msg.tool_calls && msg.tool_calls.length > 0) {
              for (const tc of msg.tool_calls) {
                emit("tool_call", {
                  step,
                  name: tc.function.name,
                  args: tc.function.arguments,
                });

                const toolResult = await self.executeTool(tc, log);

                emit("tool_result", {
                  step,
                  name: tc.function.name,
                  result: toolResult.slice(0, 2000),
                });

                if (tc.function.name === "done") {
                  try {
                    const args = JSON.parse(tc.function.arguments);
                    emit("done", {
                      step,
                      summary: args.summary || toolResult,
                    });
                  } catch {
                    emit("done", { step, summary: toolResult });
                  }

                  // Store in log
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
                    `[Autonomous: ${step} steps] ${toolResult}`,
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

  // ─── Tool Execution ────────────────────────────────────

  private async executeTool(
    tc: ToolCall,
    log: ReturnType<typeof logger.forRequest>,
  ): Promise<string> {
    const name = tc.function.name;
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(tc.function.arguments);
    } catch {
      return JSON.stringify({ error: "Invalid JSON arguments" });
    }

    log.info(
      "agent-loop",
      `Tool: ${name}(${JSON.stringify(args).slice(0, 200)})`,
      {
        meta: { tool: name },
      },
    );

    try {
      switch (name) {
        case "memory_search": {
          const result = this.tools.memorySearch(
            args.query as string,
            args.layer as string | undefined,
            args.limit as number | undefined,
          );
          return JSON.stringify(result);
        }
        case "memory_write": {
          const result = this.tools.memoryWrite(args as any);
          return JSON.stringify(result);
        }
        case "rag_search": {
          const result = await this.tools.ragSearch(
            args.query as string,
            undefined,
            args.top_n as number | undefined,
          );
          return JSON.stringify(result);
        }
        case "think": {
          // think tool — pure reasoning, no side effects
          return JSON.stringify({
            success: true,
            data: `Thought recorded: ${(args.thought as string).slice(0, 500)}`,
          });
        }
        case "done": {
          return args.summary as string;
        }
        case "consult_specialists": {
          if (!this.room) {
            return JSON.stringify({
              error: "ArbitrationRoom not configured",
            });
          }
          const specialists = (args.specialists as string[]) || [
            "coder",
            "critic",
            "generalist",
          ];
          const category =
            (args.category as
              | "code"
              | "architecture"
              | "review"
              | "reasoning") || "reasoning";
          const ctx = (args.context as string) || "";
          const question = args.question as string;
          const fullQuestion = ctx
            ? `${question}\n\nКонтекст: ${ctx}`
            : question;

          const result = await this.room.run(fullQuestion, "", {
            agents: specialists,
            category,
          });

          return JSON.stringify({
            success: true,
            data: {
              synthesis: result.synthesis,
              responses: result.agentResponses.map((r) => ({
                role: r.role,
                content: r.content.slice(0, 3000),
                timedOut: r.timedOut,
              })),
            },
          });
        }
        case "create_tool": {
          const def: DynamicToolDef = {
            name: args.name as string,
            description: args.description as string,
            model: (args.model as string) || "flash",
            promptTemplate: args.prompt_template as string,
            parameters: {
              type: "object",
              properties: {
                input: {
                  type: "string",
                  description:
                    (args.input_description as string) || "Input for this tool",
                },
              },
              required: ["input"],
            },
            createdAt: new Date().toISOString(),
          };

          const result = this.dynamicTools.register(def);
          if (result.success) {
            this.persistDynamicTools();
            log.info(
              "agent-loop",
              `Dynamic tool created: ${def.name} → ${def.model}`,
            );
          }
          return JSON.stringify(result);
        }
        case "list_tools": {
          const dynamic = this.dynamicTools.list();
          return JSON.stringify({
            success: true,
            data: {
              static_tools: AGENT_TOOLS.map((t) => t.function.name),
              dynamic_tools: dynamic.map((t) => ({
                name: t.name,
                description: t.description,
                model: t.model,
                createdAt: t.createdAt,
              })),
            },
          });
        }
        default: {
          // Check if it's a dynamic tool
          const dynTool = this.dynamicTools.get(name);
          if (dynTool) {
            return await this.executeDynamicTool(dynTool, args, log);
          }
          return JSON.stringify({ error: `Unknown tool: ${name}` });
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("agent-loop", `Tool ${name} failed: ${msg}`);
      return JSON.stringify({ error: msg });
    }
  }

  // ─── Dynamic Tool Execution ─────────────────────────────

  private async executeDynamicTool(
    def: DynamicToolDef,
    args: Record<string, unknown>,
    log: ReturnType<typeof logger.forRequest>,
  ): Promise<string> {
    const input = (args.input as string) || "";
    const systemPrompt = def.promptTemplate.replace(/\{\{input\}\}/g, input);

    log.info(
      "agent-loop",
      `Dynamic tool ${def.name} → ${def.model} (${input.slice(0, 100)})`,
    );

    try {
      const response = await this.router.chat(def.model, {
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: input },
        ],
        max_tokens: 4096,
        temperature: 0.5,
      });

      const content = response.choices[0]?.message?.content || "";
      return JSON.stringify({ success: true, data: content });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("agent-loop", `Dynamic tool ${def.name} failed: ${msg}`);
      return JSON.stringify({ error: msg });
    }
  }

  // ─── System Prompt Builder ─────────────────────────────

  private async buildAgentSystemPrompt(
    task: string,
    model: string,
  ): Promise<string> {
    const parts: string[] = [];

    // Persona
    parts.push(getPersonaBio(model));

    // Agent-specific instructions
    parts.push(`
## Режим: Автономный агент

**Дата:** ${getCurrentDate()}
**Лимит шагов:** ${MAX_STEPS} (после этого тебя принудительно остановят)
**Контекст:** ~${MAX_CONTEXT_TOKENS} токенов максимум. Текущий шаг и остаток будут указаны в [системных метках] перед каждым вызовом.

Ты работаешь в **автономном режиме**. У тебя есть инструменты для работы с памятью, поиска и консультации со специалистами команды.
Тебе дана задача — выполни её по шагам.

### Правила:
1. **Думай перед действием** — используй tool \`think\` для планирования
2. **Проверяй факты** — ищи в памяти через \`memory_search\` и \`rag_search\`
3. **Сохраняй важное** — записывай решения и факты через \`memory_write\`
4. **Советуйся с командой** — используй \`consult_specialists\` для сложных вопросов (кодер, критик, генералист)
5. **Закончи явно** — когда задача выполнена, вызови \`done\` с финальным резюме
6. **Не зацикливайся** — если не можешь найти ответ за 3-5 попыток, остановись и сообщи что знаешь
7. **Следи за бюджетом** — перед каждым вызовом ты увидишь [системную метку] с номером шага, остатком вызовов и использованным контекстом

### Доступные инструменты:
- \`think\` — записать рассуждение (без побочных эффектов)
- \`memory_search\` — FTS поиск по памяти
- \`rag_search\` — гибридный RAG поиск (точнее, но дороже: 1-2 RPM)
- \`memory_write\` — записать факт/решение в память
- \`consult_specialists\` — совещание с командой (кодер, критик, генералист). Дорого: 3-4 RPM
- \`create_tool\` — создать новый динамический инструмент (промт-шаблон → специалист). Макс. ${MAX_DYNAMIC_TOOLS} за сессию
- \`list_tools\` — показать все доступные инструменты (статические + динамические)
- \`done\` — завершить задачу с резюме для пользователя

### Создание инструментов:
Ты можешь расширять свои возможности через \`create_tool\`. Каждый кастомный инструмент — это промт-шаблон, который при вызове отправляется выбранному специалисту (coder/critic/generalist/flash). Используй \`{{input}}\` в шаблоне как плейсхолдер. Кастомные инструменты сохраняются между сессиями.`);

    // Focus directives
    const focus = this.memory.getAllFocus();
    if (Object.keys(focus).length > 0) {
      parts.push("\n## Текущие директивы");
      for (const [key, value] of Object.entries(focus)) {
        parts.push(`- **${key}:** ${value}`);
      }
    }

    // Shared memory
    const shared = this.memory.getAllShared();
    if (shared.length > 0) {
      parts.push("\n## Общая память (факты о пользователе)");
      for (const entry of shared) {
        parts.push(`- [${entry.category}] ${entry.content}`);
      }
    }

    // Quick RAG for task relevance
    try {
      const ragResults = await this.rag
        .search({ query: task, rerankTopN: 3 })
        .catch(() => [] as RAGResult[]);
      if (ragResults.length > 0) {
        parts.push("\n## Релевантный контекст (из RAG)");
        for (const r of ragResults) {
          parts.push(`- (${r.layer}) **${r.title}**: ${r.snippet}`);
        }
      }
    } catch {
      // RAG failure is non-critical
    }

    return parts.join("\n");
  }
}
