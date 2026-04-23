/**
 * Types & constants for the Agent Loop.
 */
import type { Priority } from "../../lib/model-map";

export type ScheduleSource = "autonomous" | "free-agent";
export interface ScheduleContext {
  intervalMinutes: number;
  source: ScheduleSource;
}
import type { Message } from "../../providers/types";

// ─── Constants ───────────────────────────────────────────

export const MAX_STEPS = 100;
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
  /**
   * Scheduler context. Present = scheduled run (agent can defer optional work
   * to next cycle). Absent = interactive/one-shot (must finish in this call).
   * Only scheduler entry points populate it; /v1/autonomous leaves it undefined.
   */
  schedule?: ScheduleContext;
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

import { getMoscowNow } from "../../lib/clock";

export function getCurrentDate(): string {
  return getMoscowNow();
}

export function estimateTokens(messages: Message[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

/**
 * Session-scoped quotas for cost-heavy tools. Agent-loop creates a fresh
 * instance per run (run.ts / stream.ts); handlers check presence and
 * increment before the costly call (attempt-based semantics — a failed
 * upstream still consumes the slot, to avoid retry-amplified load).
 *
 * Lives here (not in mcp/registry) so the registry stays transport-neutral
 * and does not pull agent-loop concepts into its shape (guardrail #11).
 */
export interface AgentLoopSession {
  consultSpecialistsCount: number;
  consultSpecialistsMax: number;
  consultChaosCount: number;
  consultChaosMax: number;
}
