/**
 * ArbitrationRoom — "Common Room" multi-specialist orchestrator.
 *
 * Public API (unchanged): `run`, `classify`, `setMetrics`, types.
 * Logic delegated to: dispatch.ts (fan-out), synthesis.ts (teamlead),
 * prompts.ts (system prompt builders), weights.ts (per-category weights),
 * classify.ts (heuristic classifier).
 */

import type { Metrics } from "@subbrain/core/lib/metrics";
import type { ModelRouter } from "@subbrain/core/lib/model-router";
import { classifyMessage } from "./classify";
import { dispatchSpecialists } from "./dispatch";
import { runSynthesis } from "./synthesis";
import { type ArbitrationResult, type RoomConfig, SPECIALIST_TIMEOUT } from "./types";

export type {
  AgentResponse,
  ArbitrationResult,
  RoomConfig,
} from "./types";
export type { TaskCategory } from "./weights";

export class ArbitrationRoom {
  private metrics: Metrics | null = null;

  constructor(private router: ModelRouter) {}

  setMetrics(metrics: Metrics): void {
    this.metrics = metrics;
  }

  /**
   * Run the "Common Room" arbitration protocol:
   * 1. Dispatch to N specialists in parallel
   * 2. Collect responses (with timeout)
   * 3. Synthesize via TeamLead
   */
  async run(
    userMessage: string,
    executiveSummary: string,
    config: RoomConfig,
    externalSignal?: AbortSignal,
  ): Promise<ArbitrationResult> {
    const timeout = config.timeout || SPECIALIST_TIMEOUT;
    const deps = { router: this.router, metrics: this.metrics };

    const agentResponses = await dispatchSpecialists(
      deps,
      userMessage,
      executiveSummary,
      config,
      timeout,
      externalSignal,
    );

    // Filter out timed-out empty responses
    const validResponses = agentResponses.filter((r) => r.content.length > 0);

    // If only 1 response came through, skip synthesis
    if (validResponses.length <= 1) {
      return {
        synthesis: validResponses[0]?.content || "No responses received.",
        agentResponses,
        category: config.category,
      };
    }

    const synthesis = await runSynthesis(
      deps,
      userMessage,
      validResponses,
      config.category,
      externalSignal,
    );

    return { synthesis, agentResponses, category: config.category };
  }

  /**
   * Classify whether the request needs arbitration and pick agents.
   * Returns null if single-model is enough.
   */
  classify(userMessage: string): RoomConfig | null {
    return classifyMessage(userMessage);
  }
}
