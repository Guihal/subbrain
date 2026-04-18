import type { MemoryDB } from "../db";

// ─── Types ───────────────────────────────────────────────

/** Stats provider interface (matches ModelRouter.stats shape) */
export interface StatsProvider {
  readonly currentLoad: number;
  readonly queueLength: number;
  readonly availableSlots: number;
}

// ─── Types ───────────────────────────────────────────────

export interface RequestMetric {
  model: string;
  priority: string;
  stage: "pre" | "main" | "post" | "embed" | "rerank" | "raw";
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  status: "ok" | "error";
  errorType?: string; // "429" | "5xx" | "timeout" | "other"
}

interface SlidingCounter {
  timestamps: number[];
}

interface Counters {
  tokensIn: number;
  tokensOut: number;
  requestsOk: number;
  requestsError: number;
  errors429: number;
  errors5xx: number;
  errorsTimeout: number;
  errorsOther: number;
}

interface ModelCounters {
  requests: number;
  tokensIn: number;
  tokensOut: number;
  totalLatencyMs: number;
}

// ─── Metrics ─────────────────────────────────────────────

const WINDOW_MS = 60_000;

export class Metrics {
  private counters: Counters = {
    tokensIn: 0,
    tokensOut: 0,
    requestsOk: 0,
    requestsError: 0,
    errors429: 0,
    errors5xx: 0,
    errorsTimeout: 0,
    errorsOther: 0,
  };

  private byModel = new Map<string, ModelCounters>();
  private byPriority = new Map<string, SlidingCounter>();
  private latencies: { stage: string; ms: number; ts: number }[] = [];
  private startedAt = Date.now();

  constructor(private statsProvider: StatsProvider) {}

  /** Record a completed request metric */
  record(m: RequestMetric): void {
    const now = Date.now();

    // Global counters
    this.counters.tokensIn += m.tokensIn;
    this.counters.tokensOut += m.tokensOut;

    if (m.status === "ok") {
      this.counters.requestsOk++;
    } else {
      this.counters.requestsError++;
      switch (m.errorType) {
        case "429":
          this.counters.errors429++;
          break;
        case "5xx":
          this.counters.errors5xx++;
          break;
        case "timeout":
          this.counters.errorsTimeout++;
          break;
        default:
          this.counters.errorsOther++;
      }
    }

    // Per-model
    let mc = this.byModel.get(m.model);
    if (!mc) {
      mc = { requests: 0, tokensIn: 0, tokensOut: 0, totalLatencyMs: 0 };
      this.byModel.set(m.model, mc);
    }
    mc.requests++;
    mc.tokensIn += m.tokensIn;
    mc.tokensOut += m.tokensOut;
    mc.totalLatencyMs += m.latencyMs;

    // Per-priority RPM (sliding window)
    let pc = this.byPriority.get(m.priority);
    if (!pc) {
      pc = { timestamps: [] };
      this.byPriority.set(m.priority, pc);
    }
    pc.timestamps.push(now);

    // Latency histogram
    this.latencies.push({ stage: m.stage, ms: m.latencyMs, ts: now });
  }

  /** Get current snapshot for /metrics endpoint */
  snapshot(): MetricsSnapshot {
    const now = Date.now();
    this.pruneWindows(now);

    // RPM by priority
    const rpmByPriority: Record<string, number> = {};
    for (const [prio, counter] of this.byPriority) {
      rpmByPriority[prio] = counter.timestamps.length;
    }

    // RPM by model (from recent latencies)
    const rpmByModel: Record<string, number> = {};
    const cutoff = now - WINDOW_MS;
    for (const entry of this.latencies) {
      if (entry.ts > cutoff) {
        // We don't store model in latency; use byModel for totals instead
      }
    }

    // Latency percentiles for last minute
    const recentLatencies = this.latencies
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
      const ms = this.latencies
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
    for (const [model, mc] of this.byModel) {
      models[model] = {
        requests: mc.requests,
        tokensIn: mc.tokensIn,
        tokensOut: mc.tokensOut,
        avgLatencyMs:
          mc.requests > 0 ? Math.round(mc.totalLatencyMs / mc.requests) : 0,
      };
    }

    return {
      uptime_s: Math.round((now - this.startedAt) / 1000),
      rpm: {
        current: this.statsProvider.currentLoad,
        queue_depth: this.statsProvider.queueLength,
        available: this.statsProvider.availableSlots,
        by_priority: rpmByPriority,
      },
      tokens: {
        total_in: this.counters.tokensIn,
        total_out: this.counters.tokensOut,
      },
      requests: {
        ok: this.counters.requestsOk,
        error: this.counters.requestsError,
      },
      errors: {
        "429": this.counters.errors429,
        "5xx": this.counters.errors5xx,
        timeout: this.counters.errorsTimeout,
        other: this.counters.errorsOther,
      },
      latency: latencyStats,
      latency_by_stage: latencyByStage,
      models,
    };
  }

  /** Flush metrics to SQLite for nightly analysis */
  flush(memory: MemoryDB): void {
    const snap = this.snapshot();
    const json = JSON.stringify(snap);
    memory.db
      .query(
        "INSERT INTO metrics_log (timestamp, snapshot) VALUES (unixepoch(), ?)",
      )
      .run(json);
  }

  // ─── Internal ──────────────────────────────────────────

  private pruneWindows(now: number): void {
    const cutoff = now - WINDOW_MS;
    for (const [, counter] of this.byPriority) {
      while (counter.timestamps.length > 0 && counter.timestamps[0] <= cutoff) {
        counter.timestamps.shift();
      }
    }
    // Keep latencies for 5 minutes max (for percentile accuracy)
    const latencyCutoff = now - 5 * WINDOW_MS;
    while (this.latencies.length > 0 && this.latencies[0].ts <= latencyCutoff) {
      this.latencies.shift();
    }
  }
}

// ─── Snapshot Type ───────────────────────────────────────

export interface MetricsSnapshot {
  uptime_s: number;
  rpm: {
    current: number;
    queue_depth: number;
    available: number;
    by_priority: Record<string, number>;
  };
  tokens: {
    total_in: number;
    total_out: number;
  };
  requests: {
    ok: number;
    error: number;
  };
  errors: {
    "429": number;
    "5xx": number;
    timeout: number;
    other: number;
  };
  latency: {
    count: number;
    p50: number;
    p95: number;
    p99: number;
    max: number;
  };
  latency_by_stage: Record<string, { p50: number; p95: number; count: number }>;
  models: Record<
    string,
    {
      requests: number;
      tokensIn: number;
      tokensOut: number;
      avgLatencyMs: number;
    }
  >;
}

// ─── Helpers ─────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}
