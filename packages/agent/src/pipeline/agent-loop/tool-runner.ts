/**
 * Tool execution для агент-лупа.
 *
 * Большая часть тулов живёт в едином реестре (src/mcp/registry/).
 * Здесь — тонкая обёртка:
 *  1. Пытаемся найти тул в реестре → вызвать через registry.call()
 *  2. Иначе fallback: dynamic-тулы (созданные через create_tool)
 *  3. Иначе fallback: code-тулы (исполняемые в sandbox через `code_*`-префикс)
 */

import type { logger } from "@subbrain/core/lib/logger";
import { getTracer } from "@subbrain/core/lib/telemetry";
import type { ToolCall } from "@subbrain/providers/types";
import type { ModelRouter } from "@subbrain/core/lib/model-router";
import type { ToolExecutor, ToolRegistry } from "../../mcp";
import type { AgentLoopSession, AgentMode } from "../../mcp/registry/tool-registry";
import type { ArbitrationRoom } from "../arbitration";
import type { CodeToolRegistry } from "./code-tools";
import { executeSandboxed } from "./code-tools/sandbox";
import type { DynamicToolDef, DynamicToolRegistry } from "./dynamic-tools";

/**
 * Per-scope timeout (ms) for tool execution. Timeouts DO NOT throw — they
 * surface as `{ error: { code: "timeout", name } }` in the tool_result so the
 * model can decide whether to retry or skip ahead.
 */
const CRITIC_TIMEOUT_MS = Number(process.env.CRITIC_TIMEOUT_MS ?? 300_000);
// consult: N specialists parallel (MiniMax thinking 60-90s) + teamlead
// synthesis (60-120s). Bumped 180_000 → 600_000 (2026-05-03) — outer abort
// cascaded and killed synthesis seconds before return. 10 min ceiling.
const CONSULT_TIMEOUT_MS = Number(process.env.CONSULT_TIMEOUT_MS ?? 600_000);
const TOOL_TIMEOUTS: { prefix: string; ms: number }[] = [
  { prefix: "critic_", ms: CRITIC_TIMEOUT_MS },
  { prefix: "web_", ms: 15_000 },
  // M-10: more specific memory_* prefixes win because TOOL_TIMEOUTS is
  // first-match. `memory_reflect` calls the LLM (~30s) and embed for the
  // skip-guard; `memory_promote` does an embed + transactional insert.
  { prefix: "memory_reflect", ms: 60_000 },
  { prefix: "memory_promote", ms: 10_000 },
  { prefix: "memory_", ms: 3_000 },
  { prefix: "embed_", ms: 5_000 },
  { prefix: "task_", ms: 3_000 },
  { prefix: "consult_", ms: CONSULT_TIMEOUT_MS },
];
const DEFAULT_TOOL_TIMEOUT_MS = 10_000;

export function toolTimeoutMs(name: string): number {
  for (const { prefix, ms } of TOOL_TIMEOUTS) {
    if (name.startsWith(prefix)) return ms;
  }
  return DEFAULT_TOOL_TIMEOUT_MS;
}

const TIMEOUT_SENTINEL: unique symbol = Symbol("tool_timeout");

/**
 * Race `exec` against the per-scope timeout. On timeout the internal
 * `AbortController` is fired so the handler (and any downstream fetch /
 * router.chat / PlaywrightClient call that honors AbortSignal) can abandon
 * the in-flight work instead of continuing in the background eating RPM.
 *
 * If `externalSignal` is provided, an `AbortSignal.any([external, internal])`
 * is passed to `exec` — external abort cancels the handler too.
 */
export async function withToolTimeout<T>(
  name: string,
  exec: (signal: AbortSignal) => Promise<T>,
  externalSignal?: AbortSignal,
  overrideMs?: number,
): Promise<T | string> {
  const ms = overrideMs ?? toolTimeoutMs(name);
  const controller = new AbortController();
  const effective = externalSignal
    ? AbortSignal.any([externalSignal, controller.signal])
    : controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutP = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(TIMEOUT_SENTINEL);
    }, ms);
  });
  try {
    const res = await Promise.race([exec(effective), timeoutP]);
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
  /** B-1: per-agent identity for context-layer scoping; null = no scope. */
  agentId: string | null;
  /** SCHED-1: passed to tool ctx so handlers (e.g. tg_send_message F-4) can
   *  gate on scheduled-vs-interactive without sniffing agentId. */
  agentMode: AgentMode;
}

type Log = ReturnType<typeof logger.forRequest>;

function parseOk(result: string): { ok: boolean; code?: string } {
  try {
    const p = JSON.parse(result) as { error?: unknown; success?: boolean };
    if (p.error !== undefined) {
      const code = typeof p.error === "string" ? p.error : (p.error as { code?: string })?.code;
      return { ok: false, code };
    }
    if (p.success === false) return { ok: false };
  } catch {
    /* non-JSON = success */
  }
  return { ok: true };
}

export async function executeAgentTool(
  tc: ToolCall,
  deps: ToolRunnerDeps,
  log: Log,
): Promise<string> {
  const name = tc.function.name;
  const span = getTracer().startSpan("subbrain.tool.call", { attributes: { "tool.name": name } });

  let args: Record<string, unknown>;
  try {
    args = JSON.parse(tc.function.arguments);
  } catch {
    span.setStatus({ code: 2 });
    span.end();
    return JSON.stringify({ error: "Invalid JSON arguments" });
  }

  log.info("agent-loop", `Tool: ${name}(${JSON.stringify(args).slice(0, 200)})`, {
    meta: { tool: name },
  });

  try {
    const result = await withToolTimeout(name, async (signal) => {
      if (deps.registry.has(name)) {
        const r = await deps.registry.callAsAgent(
          name,
          args,
          {
            executor: deps.tools,
            router: deps.router,
            room: deps.room,
            dynamicTools: deps.dynamicTools,
            persistDynamicTools: deps.persistDynamicTools,
            codeTools: deps.codeTools,
            log,
            registry: deps.registry,
            session: deps.session,
            agentId: deps.agentId,
            agentMode: deps.agentMode,
          },
          signal,
        );
        if (name === "done" && r.success && typeof r.data === "string") return r.data;
        return JSON.stringify(r);
      }
      const dynTool = deps.dynamicTools.get(name);
      if (dynTool) return await executeDynamicTool(dynTool, args, deps.router, log, signal);
      if (name.startsWith("code_") && deps.codeTools) {
        const toolName = name.slice(5);
        const codeTool = deps.codeTools.getByName(toolName);
        if (codeTool) {
          if (!codeTool.enabled)
            return JSON.stringify({
              error: `Code tool "${toolName}" is disabled (too many errors)`,
            });
          const input = (args.input as string) || "";
          log.info("agent-loop", `Executing code tool: ${toolName}`);
          const res = await executeSandboxed(codeTool.code, input);
          deps.codeTools.recordRun(toolName, res.success, res.error);
          if (res.success) return res.output || "";
          return JSON.stringify({ error: res.error, durationMs: res.durationMs });
        }
      }
      return JSON.stringify({ error: `Unknown tool: ${name}` });
    });

    const { ok, code } = parseOk(result as string);
    span.setAttribute("tool.ok", ok);
    if (!ok) {
      span.setStatus({ code: 2 });
      if (code) span.setAttribute("tool.error_code", code);
    }
    return result as string;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("agent-loop", `Tool ${name} failed: ${msg}`);
    span.setAttribute("tool.ok", false);
    span.setAttribute("tool.error_code", msg);
    span.setStatus({ code: 2 });
    return JSON.stringify({ error: msg });
  } finally {
    span.end();
  }
}

async function executeDynamicTool(
  def: DynamicToolDef,
  args: Record<string, unknown>,
  router: ModelRouter,
  log: ReturnType<typeof logger.forRequest>,
  signal?: AbortSignal,
): Promise<string> {
  const input = (args.input as string) || "";
  const systemPrompt = def.promptTemplate.replace(/\{\{input\}\}/g, input);

  log.info("agent-loop", `Dynamic tool ${def.name} → ${def.model} (${input.slice(0, 100)})`);

  try {
    const response = await router.chat(def.model, {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: input },
      ],
      max_tokens: 4096,
      temperature: 0.5,
      signal,
    });

    const content = response.choices[0]?.message?.content || "";
    return JSON.stringify({ success: true, data: content });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("agent-loop", `Dynamic tool ${def.name} failed: ${msg}`);
    return JSON.stringify({ error: msg });
  }
}
