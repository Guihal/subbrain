import type { MemoryDB } from "../db";
import { pruneSlidingWindows } from "./metrics/percentile";
import { buildSnapshot } from "./metrics/snapshot";
import type { MetricsSnapshot, MetricsState, RequestMetric, StatsProvider } from "./metrics/types";

export { getCounters, incrementCounter, resetCounters } from "./metrics/counters";
export type { MetricsSnapshot, RequestMetric, StatsProvider } from "./metrics/types";

export class Metrics {
  private state: MetricsState = {
    counters: {
      tokensIn: 0,
      tokensOut: 0,
      requestsOk: 0,
      requestsError: 0,
      errors429: 0,
      errors5xx: 0,
      errorsTimeout: 0,
      errorsOther: 0,
    },
    byModel: new Map(),
    byPriority: new Map(),
    latencies: [],
  };

  private startedAt = Date.now();

  constructor(private statsProvider: StatsProvider) {}

  /** Record a completed request metric */
  record(m: RequestMetric): void {
    const now = Date.now();
    const { counters, byModel, byPriority, latencies } = this.state;

    // Global counters
    counters.tokensIn += m.tokensIn;
    counters.tokensOut += m.tokensOut;

    if (m.status === "ok") {
      counters.requestsOk++;
    } else {
      counters.requestsError++;
      switch (m.errorType) {
        case "429":
          counters.errors429++;
          break;
        case "5xx":
          counters.errors5xx++;
          break;
        case "timeout":
          counters.errorsTimeout++;
          break;
        default:
          counters.errorsOther++;
      }
    }

    // Per-model
    let mc = byModel.get(m.model);
    if (!mc) {
      mc = { requests: 0, tokensIn: 0, tokensOut: 0, totalLatencyMs: 0 };
      byModel.set(m.model, mc);
    }
    mc.requests++;
    mc.tokensIn += m.tokensIn;
    mc.tokensOut += m.tokensOut;
    mc.totalLatencyMs += m.latencyMs;

    // Per-priority RPM (sliding window)
    let pc = byPriority.get(m.priority);
    if (!pc) {
      pc = { timestamps: [] };
      byPriority.set(m.priority, pc);
    }
    pc.timestamps.push(now);

    // Latency histogram
    latencies.push({ stage: m.stage, ms: m.latencyMs, ts: now });
  }

  /** Get current snapshot for /metrics endpoint */
  snapshot(): MetricsSnapshot {
    const now = Date.now();
    pruneSlidingWindows(this.state, now);
    return buildSnapshot(this.state, this.statsProvider, this.startedAt, now);
  }

  /** Flush metrics to SQLite for nightly analysis */
  flush(memory: MemoryDB): void {
    const snap = this.snapshot();
    const json = JSON.stringify(snap);
    memory.db
      .query("INSERT INTO metrics_log (timestamp, snapshot) VALUES (unixepoch(), ?)")
      .run(json);
  }
}
