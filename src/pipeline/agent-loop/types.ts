/**
 * Types & constants for the Agent Loop.
 */
import type { Priority } from "../../lib/model-map";

export type ScheduleSource = "autonomous" | "free-agent";
export interface ScheduleContext {
  intervalMinutes: number;
  source: ScheduleSource;
}

/**
 * Agent execution mode (SCHED-1).
 *
 * - `interactive` — human triggered, in the loop. Full agent-only tool set
 *   including code-tool creation/edit primitives.
 * - `scheduled`   — autonomous scheduler / free-agent / cron-like entry.
 *   `create_tool` / `create_code_tool` / `edit_code_tool` hidden by default so
 *   a rogue model cannot write fresh executable code with no human gate.
 *   Existing dynamic + code_* tools remain callable.
 *
 * Opt-in: env `SCHEDULED_ALLOW_CODE_TOOL_CREATE=1` makes `scheduled` behave
 * like `interactive` (for manual operator runs on a scheduler endpoint).
 */
export type AgentMode = "scheduled" | "interactive";

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
  /**
   * Execution mode (SCHED-1). Default `"interactive"`.
   * Scheduler entrypoints MUST pass `"scheduled"`; HTTP routes triggered by a
   * human pass `"interactive"` (the default).
   */
  agentMode?: AgentMode;
  /**
   * B-1: per-agent identity used to scope context-layer reads/writes.
   * Schedulers ("autonomous", "free-agent") MUST set this. HTTP routes
   * derive it from headers / session / authed user; absent / null = no
   * scope (admin / legacy back-compat).
   */
  agentId?: string | null;
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
