/**
 * Agent-only мета-тулы: think, done, consult_specialists, consult_chaos,
 * create_tool, list_tools.
 *
 * Эти тулы не выставляются в REST / MCP JSON-RPC — видны только агент-лупу.
 * Требуют расширенный ToolContext: router, room, dynamicTools, log, registry.
 */
import { t, type ToolRegistry } from "./tool-registry";
import type { DynamicToolDef } from "../../pipeline/agent-loop/dynamic-tools";

export function registerAgentMetaTools(registry: ToolRegistry): void {
  registry.register({
    name: "think",
    description:
      "Use this tool to think step-by-step about a complex problem before acting. Write your reasoning here. No side effects.",
    scope: "agent-only",
    input: t.Object({
      thought: t.String({ description: "Your reasoning / chain of thought" }),
    }),
    handler: (args) => ({
      success: true,
      data: `Thought recorded: ${args.thought.slice(0, 500)}`,
    }),
  });

  registry.register({
    name: "done",
    description:
      "Signal that you have completed the task. Include final summary for the user.",
    scope: "agent-only",
    input: t.Object({
      summary: t.String({ description: "Final result/summary for the user" }),
    }),
    handler: (args) => ({ success: true, data: args.summary }),
  });

  registry.register({
    name: "consult_specialists",
    description:
      "Consult other AI specialists (Coder, Critic, Generalist, Chaos) in parallel and synthesize a combined answer. Costs 3-5 RPM.",
    scope: "agent-only",
    input: t.Object({
      question: t.String(),
      context: t.Optional(t.String()),
      specialists: t.Optional(
        t.Array(
          t.Union([
            t.Literal("coder"),
            t.Literal("critic"),
            t.Literal("generalist"),
            t.Literal("chaos"),
          ]),
        ),
      ),
      category: t.Optional(
        t.Union([
          t.Literal("code"),
          t.Literal("architecture"),
          t.Literal("review"),
          t.Literal("reasoning"),
        ]),
      ),
    }),
    handler: async (args, ctx) => {
      if (!ctx.room) {
        return { success: false, error: "ArbitrationRoom not configured" };
      }
      const specialists =
        args.specialists && args.specialists.length > 0
          ? args.specialists
          : ["coder", "critic", "generalist", "chaos"];
      const category = args.category || "reasoning";
      const fullQuestion = args.context
        ? `${args.question}\n\nКонтекст: ${args.context}`
        : args.question;

      const result = await ctx.room.run(fullQuestion, "", {
        agents: specialists,
        category,
      });
      return {
        success: true,
        data: {
          synthesis: result.synthesis,
          responses: result.agentResponses.map((r) => ({
            role: r.role,
            content: r.content.slice(0, 3000),
            timedOut: r.timedOut,
          })),
        },
      };
    },
  });

  registry.register({
    name: "consult_chaos",
    description:
      "Ask the Chaos Advisor (Mistral, free NVIDIA) for proactive ideas when you don't know what to do next. Returns 3 concrete action suggestions. Costs 0 Copilot RPM.",
    scope: "agent-only",
    input: t.Object({
      context: t.String({
        description:
          "What you've already done this session / what you know about current situation",
      }),
      question: t.Optional(
        t.String({ description: "Specific question (default: 'What to do next?')" }),
      ),
    }),
    handler: async (args, ctx) => {
      if (!ctx.router) {
        return { success: false, error: "Router not configured" };
      }
      const context = args.context || "Нет контекста";
      const question =
        args.question ||
        "Что делать дальше? Предложи 3 конкретных действия.";

      const chaosPrompt = `Ты — генератор идей для AI-агента. Агент работает на фрилансера Дмитрия (22 года, Nuxt/TypeScript/PHP стек, ищет доход, живёт с девушкой Никой).

Что агент уже сделал / знает: ${context}
Текущее время: ${new Date().toLocaleString("ru-RU")}

Предложи 3 КОНКРЕТНЫХ действия, которые агент может сделать ПРЯМО СЕЙЧАС.
Требования:
- Каждое действие выполнимо за 5-10 минут с помощью интернета
- Будь дерзким и нестандартным — агент осторожный, ему нужен пинок
- Не повторяй то, что уже сделано
- Формат: 1. [действие] — [почему полезно]

НЕ предлагай банальщину типа "проверь почту". Предлагай конкретные сайты, запросы, действия.`;

      ctx.log?.info("agent-loop", "Consulting chaos advisor (NVIDIA Mistral)");

      try {
        const response = await ctx.router.chat(
          "chaos",
          {
            messages: [
              { role: "system", content: chaosPrompt },
              { role: "user", content: question },
            ],
            max_tokens: 1024,
            temperature: 0.9,
          },
          "low",
        );
        const content = response.choices[0]?.message?.content || "";
        return { success: true, data: content };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.log?.error("agent-loop", `Chaos advisor failed: ${msg}`);
        return { success: false, error: msg };
      }
    },
  });

  registry.register({
    name: "create_tool",
    description:
      "Create a new dynamic tool (prompt template → specialist model). Usable in subsequent steps. Max 10 dynamic tools per session.",
    scope: "agent-only",
    input: t.Object({
      name: t.String({
        description: "Tool name (lowercase, a-z0-9_, 2-49 chars)",
      }),
      description: t.String({ description: "What this tool does" }),
      model: t.Optional(
        t.Union([
          t.Literal("coder"),
          t.Literal("critic"),
          t.Literal("generalist"),
          t.Literal("flash"),
        ]),
      ),
      prompt_template: t.String({
        description:
          "System prompt for the specialist. Use {{input}} for the caller's input.",
      }),
      input_description: t.Optional(
        t.String({ description: "Description of the input parameter" }),
      ),
    }),
    handler: (args, ctx) => {
      if (!ctx.dynamicTools) {
        return { success: false, error: "Dynamic tools not configured" };
      }
      const def: DynamicToolDef = {
        name: args.name,
        description: args.description,
        model: args.model || "flash",
        promptTemplate: args.prompt_template,
        parameters: {
          type: "object",
          properties: {
            input: {
              type: "string",
              description: args.input_description || "Input for this tool",
            },
          },
          required: ["input"],
        },
        createdAt: new Date().toISOString(),
      };
      const result = ctx.dynamicTools.register(def);
      if (result.success) {
        ctx.persistDynamicTools?.();
        ctx.log?.info(
          "agent-loop",
          `Dynamic tool created: ${def.name} → ${def.model}`,
        );
        return { success: true, data: { name: def.name } };
      }
      return { success: false, error: result.error };
    },
  });

  registry.register({
    name: "list_tools",
    description:
      "List all currently available tools (static + dynamic tools created this session).",
    scope: "agent-only",
    input: t.Object({}),
    handler: (_args, ctx) => {
      const staticTools = ctx.registry
        ? ctx.registry.list().map((t) => t.name)
        : [];
      const dynamic = ctx.dynamicTools?.list() || [];
      return {
        success: true,
        data: {
          static_tools: staticTools,
          dynamic_tools: dynamic.map((t) => ({
            name: t.name,
            description: t.description,
            model: t.model,
            createdAt: t.createdAt,
          })),
        },
      };
    },
  });
}
