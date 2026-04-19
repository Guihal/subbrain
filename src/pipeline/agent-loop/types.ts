/**
 * Types & constants for the Agent Loop.
 */
import type { Priority } from "../../lib/model-map";
import type { Message } from "../../providers/types";

// ─── Constants ───────────────────────────────────────────

export const MAX_STEPS = 20;
export const MAX_OUTPUT_TOKENS = 128_000;
export const MAX_CONTEXT_TOKENS = 128_000;
export const AGENT_MODEL = "teamlead";
export const MAX_DYNAMIC_TOOLS = 10;

// ─── Types ───────────────────────────────────────────────

export interface AgentLoopRequest {
  task: string;
  model?: string;
  maxSteps?: number;
  sessionId?: string;
  priority?: Priority;
}

export interface AgentLoopStep {
  step: number;
  role: "assistant" | "tool";
  content: string | null;
  toolCalls?: import("../../providers/types").ToolCall[];
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

// ─── Helpers ─────────────────────────────────────────────

export function getCurrentDate(): string {
  return new Date().toLocaleDateString("ru-RU", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export function estimateTokens(messages: Message[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}
