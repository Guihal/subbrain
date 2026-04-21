/**
 * Tool execution для агент-лупа.
 *
 * Большая часть тулов живёт в едином реестре (src/mcp/registry/).
 * Здесь — тонкая обёртка:
 *  1. Пытаемся найти тул в реестре → вызвать через registry.call()
 *  2. Иначе fallback: dynamic-тулы (созданные через create_tool)
 *  3. Иначе fallback: code-тулы (исполняемые в sandbox через `code_*`-префикс)
 */
import type { ToolCall } from "../../providers/types";
import type { ToolExecutor, ToolRegistry } from "../../mcp";
import type { ModelRouter } from "../../lib/model-router";
import type { ArbitrationRoom } from "../arbitration-room";
import type { logger } from "../../lib/logger";
import type { DynamicToolDef, DynamicToolRegistry } from "./dynamic-tools";
import type { CodeToolRegistry } from "./code-tools";
import type { AgentLoopSession } from "../../mcp/registry/tool-registry";
import { executeSandboxed } from "./code-tools/sandbox";

/**
 * Per-scope timeout (ms) for tool execution. Timeouts DO NOT throw — they
 * surface as `{ error: { code: "timeout", name } }` in the tool_result so the
 * model can decide whether to retry or skip ahead.
 */
const CRITIC_TIMEOUT_MS = Number(process.env.CRITIC_TIMEOUT_MS ?? 120_000);
const TOOL_TIMEOUTS: { prefix: string; ms: number }[] = [
  { prefix: "critic_", ms: CRITIC_TIMEOUT_MS },
  { prefix: "web_", ms: 15_000 },
  { prefix: "memory_", ms: 3_000 },
  { prefix: "embed_", ms: 5_000 },
  { prefix: "consult_", ms: 60_000 },
];
const DEFAULT_TOOL_TIMEOUT_MS = 10_000;

export function toolTimeoutMs(name: string): number {
  for (const { prefix, ms } of TOOL_TIMEOUTS) {
    if (name.startsWith(prefix)) return ms;
  }
  return DEFAULT_TOOL_TIMEOUT_MS;
}

const TIMEOUT_SENTINEL: unique symbol = Symbol("tool_timeout");

async function withToolTimeout<T>(
  name: string,
  exec: () => Promise<T>,
): Promise<T | string> {
  const ms = toolTimeoutMs(name);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutP = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT_SENTINEL), ms);
  });
  try {
    const res = await Promise.race([exec(), timeoutP]);
    if (res === TIMEOUT_SENTINEL) {
      return JSON.stringify({
        error: { code: "timeout", name, timeout_ms: ms },
      });
    }
    return res as T;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface ToolRunnerDeps {
  registry: ToolRegistry;
  tools: ToolExecutor;
  router: ModelRouter;
  room: ArbitrationRoom | null;
  dynamicTools: DynamicToolRegistry;
  persistDynamicTools: () => void;
  codeTools: CodeToolRegistry | null;
  session: AgentLoopSession;
}

type Log = ReturnType<typeof logger.forRequest>;

export async function executeAgentTool(
  tc: ToolCall,
  deps: ToolRunnerDeps,
  log: Log,
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
    { meta: { tool: name } },
  );

  try {
    const result = await withToolTimeout(name, async () => {
      // 1) Статический реестр — покрывает все public + agent-only тулы.
      if (deps.registry.has(name)) {
        const r = await deps.registry.call(name, args, {
          executor: deps.tools,
          router: deps.router,
          room: deps.room,
          dynamicTools: deps.dynamicTools,
          persistDynamicTools: deps.persistDynamicTools,
          codeTools: deps.codeTools,
          log,
          registry: deps.registry,
          session: deps.session,
        });

        // `done` — управляющий сигнал агента, возвращаем сырую строку summary,
        // чтобы не ломать существующий fallback в agent-loop/index.ts.
        if (name === "done" && r.success && typeof r.data === "string") {
          return r.data;
        }

        return JSON.stringify(r);
      }

      // 2) Dynamic tools (созданы агентом через create_tool)
      const dynTool = deps.dynamicTools.get(name);
      if (dynTool) {
        return await executeDynamicTool(dynTool, args, deps.router, log);
      }

      // 3) Code tools — исполняемые через префикс `code_`
      if (name.startsWith("code_") && deps.codeTools) {
        const toolName = name.slice(5);
        const codeTool = deps.codeTools.getByName(toolName);
        if (codeTool) {
          if (!codeTool.enabled) {
            return JSON.stringify({
              error: `Code tool "${toolName}" is disabled (too many errors)`,
            });
          }
          const input = (args.input as string) || "";
          log.info("agent-loop", `Executing code tool: ${toolName}`);
          const res = await executeSandboxed(codeTool.code, input);
          deps.codeTools.recordRun(toolName, res.success, res.error);
          if (res.success) return res.output || "";
          return JSON.stringify({
            error: res.error,
            durationMs: res.durationMs,
          });
        }
      }

      return JSON.stringify({ error: `Unknown tool: ${name}` });
    });
    return result as string;
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
