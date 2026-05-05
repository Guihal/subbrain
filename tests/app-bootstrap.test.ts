/**
 * Smoke test for src/app/bootstrap.ts.
 *
 * Builds a minimal fake `AppDeps` (no real providers, no network) and asserts
 * that `createApp()` returns a mounted Elysia whose `/health` endpoint answers
 * 200. This is a structural guarantee — if the bootstrap wiring breaks
 * (missing route, decorator mis-spelt, etc.) this test fails before any
 * integration test.
 */

import { describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { MemoryDB } from "@subbrain/core/db";
import { Metrics } from "@subbrain/core/lib/metrics";
import { AuthService } from "@subbrain/core/services/auth";
import { createApp } from "@subbrain/server/app/bootstrap";
import type { AppDeps } from "@subbrain/server/app/deps";

const TEST_DB = "data/test-bootstrap.db";
try {
  unlinkSync(TEST_DB);
} catch {}

function buildFakeDeps(): AppDeps {
  const memory = new MemoryDB(TEST_DB);
  const routerStats = { currentLoad: 0, queueLength: 0, availableSlots: 40 };
  const router = {
    stats: routerStats,
    get isOverloaded() {
      return false;
    },
  } as any;
  const metrics = new Metrics({
    get currentLoad() {
      return routerStats.currentLoad;
    },
    get queueLength() {
      return routerStats.queueLength;
    },
    get availableSlots() {
      return routerStats.availableSlots;
    },
  });
  return {
    config: {
      port: 4000,
      authToken: "test-token",
      dbPath: TEST_DB,
      autonomous: {
        enabled: false,
        intervalMinutes: 30,
        startupDelayMs: 0,
        maxSteps: 100,
        task: "",
      },
      nightCycle: { schedulerEnabled: false, hourUtc: 3, backlogTrigger: 100 },
      telegram: { webhookUrl: undefined, polling: false },
    } as any,
    authService: new AuthService("test-token"),
    memory,
    router,
    rag: {} as any,
    tools: {} as any,
    registry: { list: () => [], get: () => undefined } as any,
    playwright: {} as any,
    metrics,
    pipeline: {} as any,
    room: {} as any,
    nightCycle: {} as any,
    agentLoop: {} as any,
    telegramBot: null,
    userbot: null,
  };
}

describe("app/bootstrap", () => {
  test("createApp returns Elysia with /health answering 200", async () => {
    const deps = buildFakeDeps();
    const { app, nightCycleController } = createApp(deps);
    expect(nightCycleController).toBeDefined();
    expect(nightCycleController.running).toBe(false);

    const res = await app.handle(new Request("http://localhost/health"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; rpm: unknown };
    expect(body.status).toBe("ok");
    expect(body.rpm).toBeDefined();

    deps.memory.close();
  });
});
