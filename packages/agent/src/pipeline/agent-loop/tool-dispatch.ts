/**
 * Tool-call normalization + dispatch for the agent loop.
 *
 * Providers already translate to OpenAI shape (`tool_calls[].function`), but
 * `normalizeToolCalls` also accepts raw Anthropic `{type:"tool_use"}` blocks
 * so fixtures / tests / future providers do not explode here.
 */

import type { logger } from "@subbrain/core/lib/logger";
import type { ToolCall } from "@subbrain/providers/types";
import { executeAgentTool, type ToolRunnerDeps } from "./tool-runner";

export interface NormalizedCall {
  id: string;
  name: string;
  /** JSON string, exactly as the model emitted it. */
  args: string;
}

type AnthropicToolUse = {
  type: "tool_use";
  id?: string;
  name: string;
  input?: unknown;
};

type OpenAIToolCall = {
  id?: string;
  type?: "function";
  function: { name: string; arguments?: string };
};

export function normalizeToolCalls(raw: unknown): NormalizedCall[] {
  if (!Array.isArray(raw)) return [];
  const out: NormalizedCall[] = [];
  for (const c of raw) {
    if (!c || typeof c !== "object") continue;
    const oa = c as OpenAIToolCall;
    if (oa.function?.name) {
      out.push({
        id: String(oa.id ?? ""),
        name: oa.function.name,
        args:
          typeof oa.function.arguments === "string"
            ? oa.function.arguments
            : JSON.stringify(oa.function.arguments ?? {}),
      });
      continue;
    }
    const an = c as AnthropicToolUse;
    if (an.type === "tool_use" && typeof an.name === "string") {
      out.push({
        id: String(an.id ?? ""),
        name: an.name,
        args: JSON.stringify(an.input ?? {}),
      });
    }
  }
  return out;
}

export interface ToolCallOutcome {
  toolResult: string;
  isDone: boolean;
  doneSummary?: string;
}

type Log = ReturnType<typeof logger.forRequest>;

/**
 * Execute a single tool_call and detect the `done` control signal.
 * `done`'s summary is parsed from `arguments.summary`; falls back to the raw
 * tool result (tool-runner returns the summary as a raw string for `done`).
 */
export async function runToolCall(
  tc: ToolCall,
  deps: ToolRunnerDeps,
  log: Log,
): Promise<ToolCallOutcome> {
  const toolResult = await executeAgentTool(tc, deps, log);
  if (tc.function.name !== "done" && tc.function.name !== "done_with_artifact") {
    return { toolResult, isDone: false };
  }
  let summary: string | undefined;
  try {
    const parsed = JSON.parse(tc.function.arguments) as { summary?: unknown };
    if (typeof parsed.summary === "string") summary = parsed.summary;
  } catch {
    // fall through to toolResult
  }
  if (tc.function.name === "done_with_artifact") {
    return { toolResult, isDone: true, doneSummary: toolResult };
  }
  return { toolResult, isDone: true, doneSummary: summary || toolResult };
}
