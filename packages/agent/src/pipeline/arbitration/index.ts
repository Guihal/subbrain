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
import { LocalParticipant } from "./participants";
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

  async run(
    userMessage: string,
    executiveSummary: string,
    config: RoomConfig,
    externalSignal?: AbortSignal,
  ): Promise<ArbitrationResult> {
    const timeout = config.timeout || SPECIALIST_TIMEOUT;
    const deps = { router: this.router, metrics: this.metrics };
    const participants = config.agents.map((role) => new LocalParticipant(role, deps));

    const agentResponses = await dispatchSpecialists(
      participants,
      userMessage,
      executiveSummary,
      config.category,
      timeout,
      externalSignal,
    );

    const validResponses = agentResponses.filter((r) => r.content.length > 0);
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

  classify(userMessage: string): RoomConfig | null {
    return classifyMessage(userMessage);
  }
}
