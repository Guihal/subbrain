/**
 * One step of the agent loop.
 *
 * Shared by non-stream `runLoop` and stream `runStreamLoop`. The caller
 * supplies hooks so it can log into `AgentLoopStep[]` (sync) or emit SSE
 * events (stream) without duplicating the orchestration code.
 */
import type { Message, Tool, ToolCall } from "../../providers/types";
import type { Priority } from "../../lib/model-map";
import type { ModelRouter } from "../../lib/model-router";
import type { MemoryDB } from "../../db";
import type { logger } from "../../lib/logger";
import type { ToolRunnerDeps } from "./tool-runner";
import { runToolCall } from "./tool-dispatch";
import { maybeCompress } from "./compressor-hook";
import { estimateTokens, MAX_CONTEXT_TOKENS } from "./types";

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
): Promise<StepResult> {
  const { step, maxSteps, model, priority, messages, getAllTools } = input;

  // Compress before the call if we crossed the soft limit.
  const tokensBefore = estimateTokens(messages);
  const compressed = await maybeCompress(messages, deps.router, deps.memory);
  if (compressed) {
    hooks.onCompress?.(tokensBefore, estimateTokens(messages));
  }

  // Budget note as a user message (system-after-tool is invalid for some providers).
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
      },
      priority,
    );
  } finally {
    messages.pop(); // remove budget note regardless of outcome
  }

  const choice = response.choices[0];
  if (!choice) return { kind: "error", error: "Empty response from model" };

  const msg = choice.message;
  const reasoning = msg.reasoning_content || "";
  if (reasoning) hooks.onThinking?.(reasoning);

  // Case 1: tool_calls
  if (msg.tool_calls && msg.tool_calls.length > 0) {
    const assistantMsg: Message = {
      role: "assistant",
      content: msg.content,
      tool_calls: msg.tool_calls,
    };
    hooks.onAssistantWithTools?.(assistantMsg);
    messages.push(assistantMsg);

    for (const tc of msg.tool_calls) {
      hooks.onToolCallStart?.(tc);
      const { toolResult, isDone, doneSummary } = await runToolCall(
        tc,
        deps.tools,
        log,
      );
      hooks.onToolCallResult?.(tc, toolResult);

      messages.push({
        role: "tool",
        content: toolResult,
        tool_call_id: tc.id,
      });

      if (isDone) {
        return { kind: "done", summary: doneSummary ?? toolResult };
      }
    }
    return { kind: "tools" };
  }

  // Case 2: plain content → nudge to keep iterating
  const content = msg.content || reasoning || "";
  if (content) {
    hooks.onAssistantContent?.(content);
    messages.push({ role: "assistant", content });
    messages.push({ role: "user", content: NUDGE_AFTER_CONTENT });
    return { kind: "assistant", content };
  }

  // Case 3: empty response → nudge harder
  hooks.onWarn?.("empty response");
  messages.push({ role: "user", content: NUDGE_AFTER_EMPTY });
  return { kind: "empty" };
}
