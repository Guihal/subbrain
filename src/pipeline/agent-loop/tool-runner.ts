/**
 * Tool execution logic for the agent loop.
 * Handles both static tools and dynamic (runtime-created) tools.
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

export async function executeAgentTool(
  tc: ToolCall,
  deps: ToolRunnerDeps,
  log: ReturnType<typeof logger.forRequest>,
): Promise<string> {
  const name = tc.function.name;
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(tc.function.arguments);
  } catch {
    return JSON.stringify({ error: "Invalid JSON arguments" });
  }

  log.info("agent-loop", `Tool: ${name}(${JSON.stringify(args).slice(0, 200)})`, {
    meta: { tool: name },
  });

  try {
    switch (name) {
      case "memory_search": {
        const result = deps.tools.memorySearch(
          args.query as string,
          args.layer as string | undefined,
          args.limit as number | undefined,
        );
        return JSON.stringify(result);
      }
      case "memory_write": {
        const result = deps.tools.memoryWrite(args as any);
        return JSON.stringify(result);
      }
      case "rag_search": {
        const result = await deps.tools.ragSearch(
          args.query as string,
          undefined,
          args.top_n as number | undefined,
        );
        return JSON.stringify(result);
      }
      case "think": {
        return JSON.stringify({
          success: true,
          data: `Thought recorded: ${(args.thought as string).slice(0, 500)}`,
        });
      }
      case "done": {
        return args.summary as string;
      }
      case "consult_specialists": {
        if (!deps.room) {
          return JSON.stringify({ error: "ArbitrationRoom not configured" });
        }
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
        const fullQuestion = ctx
          ? `${question}\n\nКонтекст: ${ctx}`
          : question;

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

        const result = deps.dynamicTools.register(def);
        if (result.success) {
          deps.persistDynamicTools();
          log.info("agent-loop", `Dynamic tool created: ${def.name} → ${def.model}`);
        }
        return JSON.stringify(result);
      }
      case "list_tools": {
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
      }

      // ─── Telegram Chat Tools ─────────────────────────────────
      case "tg_list_chats": {
        const result = await deps.tools.tgListChats(args.limit as number | undefined);
        return JSON.stringify(result);
      }
      case "tg_read_chat": {
        const result = await deps.tools.tgReadChat(
          args.chat_id as string,
          args.limit as number | undefined,
          args.offset_id as number | undefined,
        );
        return JSON.stringify(result);
      }
      case "tg_search_messages": {
        const result = await deps.tools.tgSearchMessages(
          args.query as string,
          args.limit as number | undefined,
          args.chat_id as string | undefined,
        );
        return JSON.stringify(result);
      }
      case "tg_exclude_chat": {
        const result = deps.tools.tgExcludeChat(
          args.chat_id as string,
          args.chat_title as string,
          args.reason as string | undefined,
        );
        return JSON.stringify(result);
      }
      case "tg_include_chat": {
        const result = deps.tools.tgIncludeChat(args.chat_id as string);
        return JSON.stringify(result);
      }
      case "tg_list_excluded": {
        const result = deps.tools.tgListExcluded();
        return JSON.stringify(result);
      }
      case "tg_send_message": {
        const result = await deps.tools.tgSendMessage(args.text as string);
        return JSON.stringify(result);
      }

      // ─── Web Browsing Tools (Playwright MCP) ─────────────
      case "web_navigate": {
        const result = await deps.tools.webCallTool("browser_navigate", { url: args.url });
        return result;
      }
      case "web_snapshot": {
        const result = await deps.tools.webCallTool("browser_snapshot", {});
        return result;
      }
      case "web_click": {
        const result = await deps.tools.webCallTool("browser_click", {
          element: args.element,
          ref: args.ref,
        });
        return result;
      }
      case "web_type": {
        const toolArgs: Record<string, unknown> = {
          element: args.element,
          ref: args.ref,
          text: args.text,
        };
        if (args.submit) toolArgs.submit = true;
        const result = await deps.tools.webCallTool("browser_type", toolArgs);
        return result;
      }
      case "web_back": {
        const result = await deps.tools.webCallTool("browser_go_back", {});
        return result;
      }
      case "web_press_key": {
        const result = await deps.tools.webCallTool("browser_press_key", { key: args.key });
        return result;
      }

      default: {
        const dynTool = deps.dynamicTools.get(name);
        if (dynTool) {
          return await executeDynamicTool(dynTool, args, deps.router, log);
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
