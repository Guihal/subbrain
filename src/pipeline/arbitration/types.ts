/**
 * Shared type definitions for ArbitrationRoom split-folder.
 * Re-exported from index.ts as the public API surface.
 */

import type { TaskCategory } from "./weights";

export type { TaskCategory };

export interface RoomConfig {
  /** Which specialist roles to invoke */
  agents: string[];
  /** Task category (affects weights) */
  category: TaskCategory;
  /** Timeout per specialist in ms */
  timeout?: number;
}

export interface AgentResponse {
  role: string;
  content: string;
  latencyMs: number;
  timedOut: boolean;
}

export interface ArbitrationResult {
  synthesis: string;
  agentResponses: AgentResponse[];
  category: TaskCategory;
}

export const SPECIALIST_TIMEOUT = Number(process.env.SPECIALIST_TIMEOUT_MS) || 30_000;

// Synthesis runs after specialists; without its own ceiling it inherits the
// outer consult_* budget, and outer-abort cascades kill near-finished calls.
// Read at call time so tests can override SYNTHESIS_TIMEOUT_MS without a full
// module re-import (transitive imports stay cached past `?t=` query suffix).
export function getSynthesisTimeout(): number {
  return Number(process.env.SYNTHESIS_TIMEOUT_MS) || 60_000;
}
