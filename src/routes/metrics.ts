/**
 * Aggregated metrics endpoint — returns rolled-up cost/latency
 * from metrics_log snapshots for a given time range.
 */
import { Elysia, t } from "elysia";
import type { MetricsRepository } from "../repositories/metrics.repo";

interface MetricsSnapshot {
  uptime_s: number;
  rpm: {
    current: number;
    queue_depth: number;
    available: number;
    by_priority: Record<string, number>;
  };
  tokens: { total_in: number; total_out: number };
  requests: { ok: number; error: number };
  errors: { "429": number; "5xx": number; timeout: number; other: number };
  latency: { count: number; p50: number; p95: number; p99: number; max: number };
  latency_by_stage: Record<string, { p50: number; p95: number; count: number }>;
  models: Record<string, { requests: number; tokensIn: number; tokensOut: number; avgLatencyMs: number }>;
}

function aggregateSnapshots(rows: { timestamp: number; snapshot: string }[]) {
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let totalRequestsOk = 0;
  let totalRequestsError = 0;
  let totalErrors429 = 0;
  let totalErrors5xx = 0;
  let totalErrorsTimeout = 0;
  let totalErrorsOther = 0;

  const modelAgg: Record<string, { requests: number; tokensIn: number; tokensOut: number; totalLatencyMs: number }> = {};
  const latencies: number[] = [];
  const stageAgg: Record<string, { p50s: number[]; p95s: number[]; counts: number[] }> = {};

  for (const row of rows) {
    const snap: MetricsSnapshot = JSON.parse(row.snapshot);

    totalTokensIn += snap.tokens.total_in;
    totalTokensOut += snap.tokens.total_out;
    totalRequestsOk += snap.requests.ok;
    totalRequestsError += snap.requests.error;
    totalErrors429 += snap.errors["429"];
    totalErrors5xx += snap.errors["5xx"];
    totalErrorsTimeout += snap.errors.timeout;
    totalErrorsOther += snap.errors.other;

    for (const [name, m] of Object.entries(snap.models)) {
      const a = modelAgg[name] ?? { requests: 0, tokensIn: 0, tokensOut: 0, totalLatencyMs: 0 };
      a.requests += m.requests;
      a.tokensIn += m.tokensIn;
      a.tokensOut += m.tokensOut;
      a.totalLatencyMs += m.avgLatencyMs * m.requests;
      modelAgg[name] = a;
    }

    if (snap.latency.count > 0) {
      latencies.push(snap.latency.p50);
      latencies.push(snap.latency.p95);
      latencies.push(snap.latency.p99);
    }

    for (const [stage, s] of Object.entries(snap.latency_by_stage)) {
      const a = stageAgg[stage] ?? { p50s: [], p95s: [], counts: [] };
      a.p50s.push(s.p50);
      a.p95s.push(s.p95);
      a.counts.push(s.count);
      stageAgg[stage] = a;
    }
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const p50 = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.5)] : 0;
  const p95 = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.95)] || sorted[sorted.length - 1] : 0;

  const models: Record<string, { requests: number; tokensIn: number; tokensOut: number; avgLatencyMs: number }> = {};
  for (const [name, a] of Object.entries(modelAgg)) {
    models[name] = {
      requests: a.requests,
      tokensIn: a.tokensIn,
      tokensOut: a.tokensOut,
      avgLatencyMs: a.requests > 0 ? Math.round(a.totalLatencyMs / a.requests) : 0,
    };
  }

  const latency_by_stage: Record<string, { p50: number; p95: number; count: number }> = {};
  for (const [stage, a] of Object.entries(stageAgg)) {
    const totalCount = a.counts.reduce((s, c) => s + c, 0);
    const weightedP50 = totalCount > 0
      ? Math.round(a.p50s.reduce((s, v, i) => s + v * a.counts[i], 0) / totalCount)
      : 0;
    const weightedP95 = totalCount > 0
      ? Math.round(a.p95s.reduce((s, v, i) => s + v * a.counts[i], 0) / totalCount)
      : 0;
    latency_by_stage[stage] = { p50: weightedP50, p95: weightedP95, count: totalCount };
  }

  return {
    snapshots: rows.length,
    tokens: { total_in: totalTokensIn, total_out: totalTokensOut },
    requests: { ok: totalRequestsOk, error: totalRequestsError },
    errors: {
      "429": totalErrors429,
      "5xx": totalErrors5xx,
      timeout: totalErrorsTimeout,
      other: totalErrorsOther,
    },
    latency: { count: latencies.length, p50, p95 },
    latency_by_stage,
    models,
  };
}

export function metricsRunsRoute(metricsRepo: MetricsRepository) {
  return new Elysia({ prefix: "/v1/metrics/runs" })
    .get(
      "/",
      ({ query, set }) => {
        const now = Math.floor(Date.now() / 1000);
        const from = query.from ?? now - 86400;
        const to = query.to ?? now;

        if (from > to) {
          set.status = 400;
          return { error: { message: "from must not be greater than to" } };
        }

        const rows = metricsRepo.listInRange(from, to);
        return aggregateSnapshots(rows);
      },
      {
        query: t.Object({
          from: t.Optional(t.Number({ minimum: 0 })),
          to: t.Optional(t.Number({ minimum: 0 })),
        }),
      },
    );
}
