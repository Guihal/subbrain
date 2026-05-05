import { beforeEach, describe, expect, test } from "bun:test";
import { MemoryDB } from "@subbrain/core/db";
import { MetricsRepository } from "@subbrain/core/repositories/metrics.repo";
import { Elysia } from "elysia";
import { metricsRunsRoute } from "../src/routes/metrics";

describe("GET /v1/metrics/runs", () => {
  let db: MemoryDB;
  let repo: MetricsRepository;
  let app: Elysia;

  beforeEach(() => {
    db = new MemoryDB(":memory:");
    repo = new MetricsRepository(db.db);
    app = new Elysia().use(metricsRunsRoute(repo));
  });

  test("returns empty aggregate when no rows", async () => {
    const res = await app.handle(
      new Request("http://localhost/v1/metrics/runs?from=0&to=9999999999"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.snapshots).toBe(0);
    expect(body.tokens).toEqual({ total_in: 0, total_out: 0 });
    expect(body.requests).toEqual({ ok: 0, error: 0 });
  });

  test("aggregates single snapshot", async () => {
    const snap = {
      uptime_s: 60,
      rpm: { current: 1, queue_depth: 0, available: 39, by_priority: {} },
      tokens: { total_in: 100, total_out: 200 },
      requests: { ok: 2, error: 0 },
      errors: { "429": 0, "5xx": 0, timeout: 0, other: 0 },
      latency: { count: 2, p50: 100, p95: 200, p99: 250, max: 300 },
      latency_by_stage: { pre: { p50: 50, p95: 100, count: 1 } },
      models: { teamlead: { requests: 2, tokensIn: 100, tokensOut: 200, avgLatencyMs: 150 } },
    };
    db.db
      .query("INSERT INTO metrics_log (timestamp, snapshot) VALUES (1000, ?)")
      .run(JSON.stringify(snap));

    const res = await app.handle(
      new Request("http://localhost/v1/metrics/runs?from=0&to=9999999999"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.snapshots).toBe(1);
    expect(body.tokens).toEqual({ total_in: 100, total_out: 200 });
    expect(body.requests).toEqual({ ok: 2, error: 0 });
    expect(body.models.teamlead.requests).toBe(2);
    expect(body.latency_by_stage.pre.count).toBe(1);
  });

  test("filters by time range", async () => {
    const snap = {
      uptime_s: 60,
      rpm: { current: 1, queue_depth: 0, available: 39, by_priority: {} },
      tokens: { total_in: 50, total_out: 50 },
      requests: { ok: 1, error: 0 },
      errors: { "429": 0, "5xx": 0, timeout: 0, other: 0 },
      latency: { count: 1, p50: 100, p95: 200, p99: 250, max: 300 },
      latency_by_stage: {},
      models: {},
    };
    db.db
      .query("INSERT INTO metrics_log (timestamp, snapshot) VALUES (100, ?)")
      .run(JSON.stringify(snap));
    db.db
      .query("INSERT INTO metrics_log (timestamp, snapshot) VALUES (200, ?)")
      .run(JSON.stringify(snap));

    const res = await app.handle(new Request("http://localhost/v1/metrics/runs?from=150&to=250"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.snapshots).toBe(1);
    expect(body.tokens.total_in).toBe(50);
  });

  test("returns 400 when from > to", async () => {
    const res = await app.handle(new Request("http://localhost/v1/metrics/runs?from=200&to=100"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("from must not be greater than to");
  });

  test("defaults to last 24h when both missing", async () => {
    const now = Math.floor(Date.now() / 1000);
    const snap = {
      uptime_s: 60,
      rpm: { current: 1, queue_depth: 0, available: 39, by_priority: {} },
      tokens: { total_in: 10, total_out: 10 },
      requests: { ok: 1, error: 0 },
      errors: { "429": 0, "5xx": 0, timeout: 0, other: 0 },
      latency: { count: 1, p50: 100, p95: 200, p99: 250, max: 300 },
      latency_by_stage: {},
      models: {},
    };
    db.db
      .query("INSERT INTO metrics_log (timestamp, snapshot) VALUES (?, ?)")
      .run(now - 3600, JSON.stringify(snap));

    const res = await app.handle(new Request("http://localhost/v1/metrics/runs"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.snapshots).toBe(1);
  });

  test("sums multiple snapshots and computes weighted model latency", async () => {
    const snap1 = {
      uptime_s: 60,
      rpm: { current: 1, queue_depth: 0, available: 39, by_priority: {} },
      tokens: { total_in: 100, total_out: 200 },
      requests: { ok: 2, error: 0 },
      errors: { "429": 0, "5xx": 0, timeout: 0, other: 0 },
      latency: { count: 2, p50: 100, p95: 200, p99: 250, max: 300 },
      latency_by_stage: {},
      models: { teamlead: { requests: 2, tokensIn: 100, tokensOut: 200, avgLatencyMs: 100 } },
    };
    const snap2 = {
      uptime_s: 120,
      rpm: { current: 2, queue_depth: 0, available: 38, by_priority: {} },
      tokens: { total_in: 200, total_out: 400 },
      requests: { ok: 4, error: 1 },
      errors: { "429": 1, "5xx": 0, timeout: 0, other: 0 },
      latency: { count: 4, p50: 150, p95: 250, p99: 300, max: 350 },
      latency_by_stage: {},
      models: { teamlead: { requests: 4, tokensIn: 200, tokensOut: 400, avgLatencyMs: 200 } },
    };
    db.db
      .query("INSERT INTO metrics_log (timestamp, snapshot) VALUES (1000, ?)")
      .run(JSON.stringify(snap1));
    db.db
      .query("INSERT INTO metrics_log (timestamp, snapshot) VALUES (2000, ?)")
      .run(JSON.stringify(snap2));

    const res = await app.handle(
      new Request("http://localhost/v1/metrics/runs?from=0&to=9999999999"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.snapshots).toBe(2);
    expect(body.tokens).toEqual({ total_in: 300, total_out: 600 });
    expect(body.requests).toEqual({ ok: 6, error: 1 });
    expect(body.errors["429"]).toBe(1);
    expect(body.models.teamlead.requests).toBe(6);
    expect(body.models.teamlead.avgLatencyMs).toBe(167); // (2*100 + 4*200) / 6 = 166.67 → 167
  });
});
