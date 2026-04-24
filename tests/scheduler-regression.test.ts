/**
 * Scheduler → AgentService regression (PR 26b — LAYER-4 services split).
 *
 * After the refactor, neither `installAutonomousScheduler` nor
 * `installFreeAgentScheduler` should touch `AgentLoop` directly — both must
 * go through `deps.agentService.run`. This test asserts that via a mock
 * AppDeps where `agentService.run` is the ONLY callable and `agentLoop` is
 * deliberately absent. If a future change re-introduces a direct
 * `agentLoop.run` in a scheduler, the test throws (`undefined is not a
 * function`) and CI catches the regression.
 */
import { describe, test, expect } from "bun:test";
import { installAutonomousScheduler } from "../src/app/schedulers";
import { installFreeAgentScheduler } from "../src/scheduler/free-agent";
import type { AppDeps } from "../src/app/deps";
import type { AgentRunOpts } from "../src/services/agent.service";
import type { AgentLoopResult } from "../src/pipeline/agent-loop";

function makeMockAgentService() {
  const calls: AgentRunOpts[] = [];
  const mock = {
    run: (opts: AgentRunOpts): Promise<AgentLoopResult> => {
      calls.push(opts);
      return Promise.resolve({
        requestId: "req",
        sessionId: opts.sessionId ?? "s",
        steps: [],
        finalAnswer: "",
        totalSteps: 0,
        stoppedReason: "done",
      });
    },
    createStream: () => new ReadableStream<Uint8Array>(),
  };
  return { mock, calls };
}

async function awaitCall(calls: unknown[], timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (calls.length === 0) {
    if (Date.now() > deadline) {
      throw new Error("agentService.run not invoked before timeout");
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("Scheduler → AgentService (LAYER-4 regression)", () => {
  test("autonomous scheduler only touches agentService.run, never agentLoop", async () => {
    const { mock, calls } = makeMockAgentService();
    const deps = {
      config: {
        autonomous: {
          enabled: true,
          intervalMinutes: 60,
          startupDelayMs: 1,
          maxSteps: 7,
          task: "regression-auto",
        },
      },
      agentService: mock,
      // `agentLoop` intentionally omitted — any accidental `deps.agentLoop.run`
      // would throw at runtime and fail this test.
    } as unknown as AppDeps;

    const handle = installAutonomousScheduler(deps);
    try {
      await awaitCall(calls);
      expect(calls[0].agentMode).toBe("scheduled");
      expect(calls[0].task).toBe("regression-auto");
      expect(calls[0].maxSteps).toBe(7);
      expect(calls[0].priority).toBe("low");
      expect(calls[0].schedule?.source).toBe("autonomous");
    } finally {
      handle.stop();
    }
  });

  test("free-agent scheduler only touches agentService.run, never agentLoop", async () => {
    const { mock, calls } = makeMockAgentService();
    const deps = {
      config: {
        freeAgent: {
          enabled: true,
          intervalMinutes: 60,
          startupDelayMs: 1,
          maxSteps: 9,
          task: "regression-free",
        },
      },
      agentService: mock,
      telegramBot: null,
    } as unknown as AppDeps;

    const handle = installFreeAgentScheduler(deps);
    try {
      await awaitCall(calls);
      expect(calls[0].agentMode).toBe("scheduled");
      expect(calls[0].task).toBe("regression-free");
      expect(calls[0].maxSteps).toBe(9);
      expect(calls[0].priority).toBe("low");
      expect(calls[0].schedule?.source).toBe("free-agent");
    } finally {
      handle.stop();
    }
  });
});
