/**
 * One step of the agent loop.
 *
 * Shared by non-stream `runLoop` and stream `runStreamLoop`. The caller
 * supplies hooks so it can log into `AgentLoopStep[]` (sync) or emit SSE
 * events (stream) without duplicating the orchestration code.
 */

import type { MemoryDB } from "@subbrain/core/db";
import type { logger } from "@subbrain/core/lib/logger";
import type { Priority } from "@subbrain/core/lib/model-map";
import { getTracer } from "@subbrain/core/lib/telemetry";
import type { Message, Tool, ToolCall } from "@subbrain/providers/types";
import type { ModelRouter } from "@subbrain/core/lib/model-router";
import { maybeCompress } from "./compressor-hook";
import { runToolCall } from "./tool-dispatch";
import type { ToolRunnerDeps } from "./tool-runner";
import { estimateTokens, MAX_CONTEXT_TOKENS, type AgentLoopRequest } from "./types";

export interface StepDeps {
  router: ModelRouter;
  memory: MemoryDB;
  tools: ToolRunnerDeps;
}

export interface StepInputs {
  step: number;
  maxSteps: number;
  model: string;
  priority: Priority;
  messages: Message[];
  getAllTools: () => Tool[];
}

export interface StepHooks {
  onCompress?: (tokensBefore: number, tokensAfter: number) => void;
  onThinking?: (reasoning: string) => void;
  onAssistantWithTools?: (msg: Message) => void;
  onAssistantContent?: (content: string) => void;
  onToolCallStart?: (tc: ToolCall) => void;
  onToolCallResult?: (tc: ToolCall, toolResult: string) => void;
  onWarn?: (reason: string) => void;
}

export type StepResult =
  | { kind: "done"; summary: string }
  | { kind: "tools" }
  | { kind: "assistant"; content: string }
  | { kind: "empty" }
  | { kind: "error"; error: string };

const NUDGE_AFTER_CONTENT =
  "[Системная метка] Ты в автономном режиме — ответ текстом никто не увидит. Продолжай работу через инструменты. Когда действительно закончил — вызови `done` с резюме.";
const NUDGE_AFTER_EMPTY =
  "[Системная метка] Пустой ответ. Вызови инструмент или `done`, чтобы продолжить.";

type Log = ReturnType<typeof logger.forRequest>;

export async function executeStep(
  deps: StepDeps,
  input: StepInputs,
  log: Log,
  hooks: StepHooks = {},
  req?: AgentLoopRequest,
): Promise<StepResult> {
  const span = getTracer().startSpan("subbrain.agent.step", {
    attributes: {
      "agent.step": input.step,
      "agent.max_steps": input.maxSteps,
      "agent.model": input.model,
      "agent.priority": input.priority,
    },
  });
  try {
    const { step, maxSteps, model, priority, messages, getAllTools } = input;
    const tokensBefore = estimateTokens(messages);
    const compressed = await maybeCompress(messages, deps.router, deps.memory);
    if (compressed) hooks.onCompress?.(tokensBefore, estimateTokens(messages));
    const budgetNote: Message = {
      role: "user",
      content: `[Системная метка: Шаг ${step}/${maxSteps} | Осталось вызовов: ${maxSteps - step + 1} | Контекст: ~${estimateTokens(messages)}/${MAX_CONTEXT_TOKENS} токенов]`,
    };
    messages.push(budgetNote);
    let response;
    try {
      response = await deps.router.chat(
        model,
        {
          messages,
          tools: getAllTools(),
          tool_choice: "auto",
          max_tokens: 128_000,
          temperature: 0.7,
          signal: req?.signal,
        },
        priority,
      );
      if (response.usage && req?.onUsage) {
        req.onUsage(response.usage);
      }
    } finally {
      messages.pop();
    }
    const choice = response.choices[0];
    if (!choice) {
      span.setStatus({ code: 2 });
      return { kind: "error", error: "Empty response from model" };
    }
    const msg = choice.message;
    const reasoning = msg.reasoning_content || "";
    if (reasoning) hooks.onThinking?.(reasoning);
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      const assistantMsg: Message = {
        role: "assistant",
        content: msg.content,
        tool_calls: msg.tool_calls,
        ...(reasoning ? { reasoning_content: reasoning } : {}),
      };
      hooks.onAssistantWithTools?.(assistantMsg);
      messages.push(assistantMsg);
      for (const tc of msg.tool_calls) {
        hooks.onToolCallStart?.(tc);
        const { toolResult, isDone, doneSummary } = await runToolCall(tc, deps.tools, log);
        hooks.onToolCallResult?.(tc, toolResult);
        messages.push({ role: "tool", content: toolResult, tool_call_id: tc.id });
        if (isDone) return { kind: "done", summary: doneSummary ?? toolResult };
      }
      return { kind: "tools" };
    }
    const visible = msg.content?.trim() ?? "";
    const content = visible || reasoning;
    if (content) {
      hooks.onAssistantContent?.(content);
      messages.push({
        role: "assistant",
        content: msg.content,
        ...(reasoning ? { reasoning_content: reasoning } : {}),
      });
      messages.push({ role: "user", content: NUDGE_AFTER_CONTENT });
      return { kind: "assistant", content };
    }
    hooks.onWarn?.("empty response");
    messages.push({ role: "user", content: NUDGE_AFTER_EMPTY });
    return { kind: "empty" };
  } catch (err) {
    span.setStatus({ code: 2 });
    throw err;
  } finally {
    span.end();
  }
}
