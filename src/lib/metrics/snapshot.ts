import {
  WINDOW_MS,
  type MetricsState,
  type MetricsSnapshot,
  type StatsProvider,
} from "./types";
import { percentile } from "./percentile";

export function buildSnapshot(
  state: MetricsState,
  stats: StatsProvider,
  startedAt: number,
  now: number,
): MetricsSnapshot {
  // RPM by priority
  const rpmByPriority: Record<string, number> = {};
  for (const [prio, counter] of state.byPriority) {
    rpmByPriority[prio] = counter.timestamps.length;
  }

  // RPM by model (from recent latencies)
  const cutoff = now - WINDOW_MS;
  for (const entry of state.latencies) {
    if (entry.ts > cutoff) {
      // We don't store model in latency; use byModel for totals instead
    }
  }

  // Latency percentiles for last minute
  const recentLatencies = state.latencies
    .filter((l) => l.ts > cutoff)
    .map((l) => l.ms)
    .sort((a, b) => a - b);

  const latencyStats = {
    count: recentLatencies.length,
    p50: percentile(recentLatencies, 0.5),
    p95: percentile(recentLatencies, 0.95),
    p99: percentile(recentLatencies, 0.99),
    max: recentLatencies[recentLatencies.length - 1] || 0,
  };

  // Per-stage latency
  const stages = ["pre", "main", "post", "embed", "rerank"] as const;
  const latencyByStage: Record<
    string,
    { p50: number; p95: number; count: number }
  > = {};
  for (const stage of stages) {
    const ms = state.latencies
      .filter((l) => l.stage === stage && l.ts > cutoff)
      .map((l) => l.ms)
      .sort((a, b) => a - b);
    if (ms.length > 0) {
      latencyByStage[stage] = {
        p50: percentile(ms, 0.5),
        p95: percentile(ms, 0.95),
        count: ms.length,
      };
    }
  }

  // Model stats
  const models: Record<
    string,
    {
      requests: number;
      tokensIn: number;
      tokensOut: number;
      avgLatencyMs: number;
    }
  > = {};
  for (const [model, mc] of state.byModel) {
    models[model] = {
      requests: mc.requests,
      tokensIn: mc.tokensIn,
      tokensOut: mc.tokensOut,
      avgLatencyMs:
        mc.requests > 0 ? Math.round(mc.totalLatencyMs / mc.requests) : 0,
    };
  }

  return {
    uptime_s: Math.round((now - startedAt) / 1000),
    rpm: {
      current: stats.currentLoad,
      queue_depth: stats.queueLength,
      available: stats.availableSlots,
      by_priority: rpmByPriority,
    },
    tokens: {
      total_in: state.counters.tokensIn,
      total_out: state.counters.tokensOut,
    },
    requests: {
      ok: state.counters.requestsOk,
      error: state.counters.requestsError,
    },
    errors: {
      "429": state.counters.errors429,
      "5xx": state.counters.errors5xx,
      timeout: state.counters.errorsTimeout,
      other: state.counters.errorsOther,
    },
    latency: latencyStats,
    latency_by_stage: latencyByStage,
    models,
  };
}
