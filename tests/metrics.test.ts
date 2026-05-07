/**
 * Metrics / Observability tests.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { MemoryDB } from "@subbrain/core/db";
import type { StatsProvider } from "@subbrain/core/lib/metrics";
import { Metrics } from "@subbrain/core/lib/metrics";

const TEST_DB = "data/test-metrics.db";

const mockStats: StatsProvider = {
  get currentLoad() {
    return 5;
  },
  get queueLength() {
    return 2;
  },
  get availableSlots() {
    return 35;
  },
};

describe("Metrics", () => {
  let metrics: Metrics;

  beforeAll(() => {
    try {
      unlinkSync(TEST_DB);
    } catch {}
    metrics = new Metrics(mockStats);
  });

  afterAll(() => {
    try {
      unlinkSync(TEST_DB);
    } catch {}
  });

  test("empty snapshot reflects provider stats and zero counters", () => {
    const snap0 = metrics.snapshot();
    expect(snap0.rpm.current).toBe(5);
    expect(snap0.rpm.available).toBe(35);
    expect(snap0.tokens.total_in).toBe(0);
    expect(snap0.requests.ok).toBe(0);
  });

  test("record + counters + per-model + latency + per-stage + rpm-by-priority", () => {
    metrics.record({
      model: "deepseek-ai/deepseek-v3.2",
      priority: "critical",
      stage: "main",
      latencyMs: 1200,
      tokensIn: 500,
      tokensOut: 250,
      status: "ok",
    });
    metrics.record({
      model: "stepfun-ai/step-3.5-flash",
      priority: "normal",
      stage: "pre",
      latencyMs: 300,
      tokensIn: 200,
      tokensOut: 100,
      status: "ok",
    });
    metrics.record({
      model: "deepseek-ai/deepseek-v3.2",
      priority: "critical",
      stage: "main",
      latencyMs: 800,
      tokensIn: 400,
      tokensOut: 200,
      status: "error",
      errorType: "5xx",
    });

    const snap = metrics.snapshot();
    expect(snap.tokens.total_in).toBe(1100);
    expect(snap.tokens.total_out).toBe(550);
    expect(snap.requests.ok).toBe(2);
    expect(snap.requests.error).toBe(1);
    expect(snap.errors["5xx"]).toBe(1);

    expect(snap.models["deepseek-ai/deepseek-v3.2"]?.requests).toBe(2);
    expect(snap.models["stepfun-ai/step-3.5-flash"]?.requests).toBe(1);
    expect(snap.models["deepseek-ai/deepseek-v3.2"]?.avgLatencyMs).toBe(1000);

    expect(snap.latency.count).toBe(3);
    expect(snap.latency.p50).toBeGreaterThan(0);
    expect(snap.latency.max).toBe(1200);

    expect(snap.latency_by_stage.main?.count).toBe(2);
    expect(snap.latency_by_stage.pre?.count).toBe(1);

    expect(snap.rpm.by_priority.critical).toBe(2);
    expect(snap.rpm.by_priority.normal).toBe(1);
  });

  test("error type breakdown + flush to SQLite + uptime", () => {
    metrics.record({
      model: "test",
      priority: "normal",
      stage: "raw",
      latencyMs: 100,
      tokensIn: 0,
      tokensOut: 0,
      status: "error",
      errorType: "429",
    });
    metrics.record({
      model: "test",
      priority: "low",
      stage: "embed",
      latencyMs: 5000,
      tokensIn: 0,
      tokensOut: 0,
      status: "error",
      errorType: "timeout",
    });

    const snap = metrics.snapshot();
    expect(snap.errors["429"]).toBe(1);
    expect(snap.errors["5xx"]).toBe(1);
    expect(snap.errors.timeout).toBe(1);
    expect(snap.uptime_s).toBeGreaterThanOrEqual(0);

    const memory = new MemoryDB(TEST_DB);
    try {
      metrics.flush(memory);
      const rows = memory.db.query("SELECT * FROM metrics_log").all() as Array<{
        snapshot: string;
      }>;
      expect(rows.length).toBe(1);
      const flushed = JSON.parse(rows[0]?.snapshot ?? "{}");
      expect(flushed.tokens.total_in).toBe(1100);
    } finally {
      memory.close();
    }
  });
});
