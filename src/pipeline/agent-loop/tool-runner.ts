/**
 * Tool execution logic for the agent loop.
 * Uses a handler registry instead of a switch block for maintainability.
 */
import type { ToolCall } from "../../providers/types";
import type { ToolExecutor } from "../../mcp/executor";
import type { ModelRouter } from "../../lib/model-router";
import type { ArbitrationRoom } from "../arbitration-room";
import type { logger } from "../../lib/logger";
import type { DynamicToolDef, DynamicToolRegistry } from "./dynamic-tools";
import { AGENT_TOOLS } from "./tool-defs";

export interface ToolRunnerDeps {
  tools: ToolExecutor;
  router: ModelRouter;
  room: ArbitrationRoom | null;
  dynamicTools: DynamicToolRegistry;
  persistDynamicTools: () => void;
}

type Args = Record<string, unknown>;
type Log = ReturnType<typeof logger.forRequest>;
type ToolHandler = (
  args: Args,
  deps: ToolRunnerDeps,
  log: Log,
) => string | Promise<string>;

// ─── Handler Registry ────────────────────────────────────

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  // Memory
  memory_search: (args, deps) =>
    JSON.stringify(
      deps.tools.memorySearch(
        args.query as string,
        args.layer as string | undefined,
        args.limit as number | undefined,
      ),
    ),

  memory_write: (args, deps) =>
    JSON.stringify(deps.tools.memoryWrite(args as any)),

  rag_search: async (args, deps) =>
    JSON.stringify(
      await deps.tools.ragSearch(
        args.query as string,
        undefined,
        args.top_n as number | undefined,
      ),
    ),

  // Meta
  think: (args) =>
    JSON.stringify({
      success: true,
      data: `Thought recorded: ${(args.thought as string).slice(0, 500)}`,
    }),

  done: (args) => args.summary as string,

  consult_specialists: async (args, deps) => {
    if (!deps.room)
      return JSON.stringify({ error: "ArbitrationRoom not configured" });
    const specialists = (args.specialists as string[]) || [
      "coder",
      "critic",
      "generalist",
      "chaos",
    ];
    const category =
      (args.category as "code" | "architecture" | "review" | "reasoning") ||
      "reasoning";
    const ctx = (args.context as string) || "";
    const question = args.question as string;
    const fullQuestion = ctx ? `${question}\n\nКонтекст: ${ctx}` : question;

    const result = await deps.room.run(fullQuestion, "", {
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
  },

  create_tool: (args, deps, log) => {
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
    const result = deps.dynamicTools.register(def);
    if (result.success) {
      deps.persistDynamicTools();
      log.info(
        "agent-loop",
        `Dynamic tool created: ${def.name} → ${def.model}`,
      );
    }
    return JSON.stringify(result);
  },

  list_tools: (_args, deps) => {
    const dynamic = deps.dynamicTools.list();
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
  },

  // Telegram
  tg_list_chats: async (args, deps) =>
    JSON.stringify(await deps.tools.tgListChats(args.limit as number | undefined)),

  tg_read_chat: async (args, deps) =>
    JSON.stringify(
      await deps.tools.tgReadChat(
        args.chat_id as string,
        args.limit as number | undefined,
        args.offset_id as number | undefined,
      ),
    ),

  tg_search_messages: async (args, deps) =>
    JSON.stringify(
      await deps.tools.tgSearchMessages(
        args.query as string,
        args.limit as number | undefined,
        args.chat_id as string | undefined,
      ),
    ),

  tg_exclude_chat: (args, deps) =>
    JSON.stringify(
      deps.tools.tgExcludeChat(
        args.chat_id as string,
        args.chat_title as string,
        args.reason as string | undefined,
      ),
    ),

  tg_include_chat: (args, deps) =>
    JSON.stringify(deps.tools.tgIncludeChat(args.chat_id as string)),

  tg_list_excluded: (_args, deps) =>
    JSON.stringify(deps.tools.tgListExcluded()),

  tg_send_message: async (args, deps) =>
    JSON.stringify(await deps.tools.tgSendMessage(args.text as string)),

  // Web browsing (Playwright MCP)
  web_navigate: async (args, deps) => {
    const url = String(args.url || "");
    if (!/^https?:\/\//i.test(url)) {
      return JSON.stringify({
        error: "Only http:// and https:// URLs are allowed",
      });
    }
    return deps.tools.webCallTool("browser_navigate", { url });
  },

  web_snapshot: async (_args, deps) =>
    deps.tools.webCallTool("browser_snapshot", {}),

  web_click: async (args, deps) =>
    deps.tools.webCallTool("browser_click", {
      element: args.element,
      ref: args.ref,
    }),

  web_type: async (args, deps) => {
    const toolArgs: Args = {
      element: args.element,
      ref: args.ref,
      text: args.text,
    };
    if (args.submit) toolArgs.submit = true;
    return deps.tools.webCallTool("browser_type", toolArgs);
  },

  web_back: async (_args, deps) =>
    deps.tools.webCallTool("browser_go_back", {}),

  web_press_key: async (args, deps) =>
    deps.tools.webCallTool("browser_press_key", { key: args.key }),
};

// ─── Public API ──────────────────────────────────────────

export async function executeAgentTool(
  tc: ToolCall,
  deps: ToolRunnerDeps,
  log: Log,
): Promise<string> {
  const name = tc.function.name;
  let args: Args;
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
    const handler = TOOL_HANDLERS[name];
    if (handler) return await handler(args, deps, log);

    // Dynamic tools fallback
    const dynTool = deps.dynamicTools.get(name);
    if (dynTool)
      return await executeDynamicTool(dynTool, args, deps.router, log);

    return JSON.stringify({ error: `Unknown tool: ${name}` });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("agent-loop", `Tool ${name} failed: ${msg}`);
    return JSON.stringify({ error: msg });
  }
}

async function executeDynamicTool(
  def: DynamicToolDef,
  args: Record<string, unknown>,
  router: ModelRouter,
  log: ReturnType<typeof logger.forRequest>,
): Promise<string> {
  const input = (args.input as string) || "";
  const systemPrompt = def.promptTemplate.replace(/\{\{input\}\}/g, input);

  log.info(
    "agent-loop",
    `Dynamic tool ${def.name} → ${def.model} (${input.slice(0, 100)})`,
  );

  try {
    const response = await router.chat(def.model, {
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
