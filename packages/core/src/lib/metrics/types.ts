/** Stats provider interface (matches ModelRouter.stats shape) */
export interface StatsProvider {
  readonly currentLoad: number;
  readonly queueLength: number;
  readonly availableSlots: number;
}

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

export interface SlidingCounter {
  timestamps: number[];
}

export interface Counters {
  tokensIn: number;
  tokensOut: number;
  requestsOk: number;
  requestsError: number;
  errors429: number;
  errors5xx: number;
  errorsTimeout: number;
  errorsOther: number;
}

export interface ModelCounters {
  requests: number;
  tokensIn: number;
  tokensOut: number;
  totalLatencyMs: number;
}

export interface LatencyEntry {
  stage: string;
  ms: number;
  ts: number;
}

export interface MetricsState {
  counters: Counters;
  byModel: Map<string, ModelCounters>;
  byPriority: Map<string, SlidingCounter>;
  latencies: LatencyEntry[];
}

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

export const WINDOW_MS = 60_000;
