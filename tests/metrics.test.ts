/**
 * Metrics / Observability tests.
 */

import { Metrics } from "../src/lib/metrics";
import type { StatsProvider } from "../src/lib/metrics";
import { MemoryDB } from "../src/db";
import { unlinkSync } from "fs";

const TEST_DB = "data/test-metrics.db";
try {
  unlinkSync(TEST_DB);
} catch {}

// Mock stats provider
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

const metrics = new Metrics(mockStats);

// ─── Test 1: Empty snapshot
const snap0 = metrics.snapshot();
console.assert(snap0.rpm.current === 5, "RPM current from provider");
console.assert(snap0.rpm.available === 35, "RPM available");
console.assert(snap0.tokens.total_in === 0, "Zero tokens initially");
console.assert(snap0.requests.ok === 0, "Zero requests initially");
console.log("✅ Empty snapshot");

// ─── Test 2: Record metrics
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

const snap1 = metrics.snapshot();
console.assert(
  snap1.tokens.total_in === 1100,
  `Tokens in: ${snap1.tokens.total_in}`,
);
console.assert(
  snap1.tokens.total_out === 550,
  `Tokens out: ${snap1.tokens.total_out}`,
);
console.assert(snap1.requests.ok === 2, `Requests ok: ${snap1.requests.ok}`);
console.assert(
  snap1.requests.error === 1,
  `Requests error: ${snap1.requests.error}`,
);
console.assert(snap1.errors["5xx"] === 1, "One 5xx error");
console.log("✅ Record + counters");

// ─── Test 3: Per-model stats
console.assert(
  snap1.models["deepseek-ai/deepseek-v3.2"]?.requests === 2,
  "DeepSeek: 2 requests",
);
console.assert(
  snap1.models["stepfun-ai/step-3.5-flash"]?.requests === 1,
  "Flash: 1 request",
);
console.assert(
  snap1.models["deepseek-ai/deepseek-v3.2"]?.avgLatencyMs === 1000,
  "DeepSeek avg latency: 1000ms",
);
console.log("✅ Per-model stats");

// ─── Test 4: Latency percentiles
console.assert(snap1.latency.count === 3, "3 latency samples");
console.assert(snap1.latency.p50 > 0, "p50 > 0");
console.assert(snap1.latency.max === 1200, `Max latency: ${snap1.latency.max}`);
console.log("✅ Latency percentiles");

// ─── Test 5: Per-stage latency
console.assert(snap1.latency_by_stage.main?.count === 2, "main: 2 samples");
console.assert(snap1.latency_by_stage.pre?.count === 1, "pre: 1 sample");
console.log("✅ Per-stage latency");

// ─── Test 6: RPM by priority
console.assert(snap1.rpm.by_priority.critical === 2, "2 critical");
console.assert(snap1.rpm.by_priority.normal === 1, "1 normal");
console.log("✅ RPM by priority");

// ─── Test 7: Error type breakdown
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

const snap2 = metrics.snapshot();
console.assert(snap2.errors["429"] === 1, "One 429");
console.assert(snap2.errors["5xx"] === 1, "One 5xx");
console.assert(snap2.errors.timeout === 1, "One timeout");
console.log("✅ Error type breakdown");

// ─── Test 8: Flush to SQLite
const memory = new MemoryDB(TEST_DB);
metrics.flush(memory);

const rows = memory.db.query("SELECT * FROM metrics_log").all() as any[];
console.assert(rows.length === 1, "One metrics snapshot flushed");
const flushed = JSON.parse(rows[0].snapshot);
console.assert(flushed.tokens.total_in === 1100, "Flushed data correct");
console.log("✅ Flush to SQLite");

// ─── Test 9: Uptime
console.assert(snap2.uptime_s >= 0, "Uptime non-negative");
console.log("✅ Uptime tracking");

// Cleanup
memory.close();
try {
  unlinkSync(TEST_DB);
} catch {}

console.log("\n🎉 All observability tests passed!");
