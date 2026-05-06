import { describe, expect, test, beforeEach } from "bun:test";
import {
  createWriteGuard,
  checkWriteCap,
  bumpWriteCount,
  emitHippoTelemetry,
  MAX_WRITES_PER_EXCHANGE,
} from "@subbrain/agent/pipeline/agent-pipeline/post/cap-guard";
import { getCounters, resetCounters } from "@subbrain/core/lib/metrics";

const log = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as any;

describe("hippocampus write cap", () => {
  beforeEach(() => {
    resetCounters();
  });

  test("createWriteGuard returns zeroed guard", () => {
    const g = createWriteGuard();
    expect(g.writesCount).toBe(0);
    expect(g.skippedDupCount).toBe(0);
  });

  test("checkWriteCap allows writes below cap", () => {
    const g = createWriteGuard();
    const result = checkWriteCap(g, "req-1", log);
    expect(result.blocked).toBe(false);
  });

  test("bumpWriteCount increments counter", () => {
    const g = createWriteGuard();
    bumpWriteCount(g);
    expect(g.writesCount).toBe(1);
    bumpWriteCount(g);
    expect(g.writesCount).toBe(2);
  });

  test("checkWriteCap blocks at exactly MAX_WRITES_PER_EXCHANGE", () => {
    const g = createWriteGuard();
    g.writesCount = MAX_WRITES_PER_EXCHANGE;
    const result = checkWriteCap(g, "req-cap", log);
    expect(result.blocked).toBe(true);
    expect(JSON.parse(result.result)).toEqual({
      ok: false,
      error: { code: "limit_exceeded", message: "max 3 writes per exchange" },
    });
  });

  test("checkWriteCap blocks above cap", () => {
    const g = createWriteGuard();
    g.writesCount = MAX_WRITES_PER_EXCHANGE + 2;
    const result = checkWriteCap(g, "req-over", log);
    expect(result.blocked).toBe(true);
  });

  test("sequence: 3 allowed, 4th blocked", () => {
    const g = createWriteGuard();
    for (let i = 0; i < MAX_WRITES_PER_EXCHANGE; i++) {
      const cap = checkWriteCap(g, `req-${i}`, log);
      expect(cap.blocked).toBe(false);
      bumpWriteCount(g);
    }
    const cap4 = checkWriteCap(g, "req-4", log);
    expect(cap4.blocked).toBe(true);
    expect(g.writesCount).toBe(MAX_WRITES_PER_EXCHANGE);
  });

  test("emitHippoTelemetry increments counter and preserves counts", () => {
    const g = createWriteGuard();
    g.writesCount = 2;
    g.skippedDupCount = 1;
    emitHippoTelemetry(g, "req-tel", 4, log);
    const counters = getCounters();
    const key = 'hippocampus_writes_per_exchange{exchange_id="req-tel",writes_count="2",skipped_dup_count="1"}';
    expect(counters.get(key)).toBe(1);
  });
});
