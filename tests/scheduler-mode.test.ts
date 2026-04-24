/**
 * SCHED-1: scheduler entrypoints (AUTONOMOUS loop + free-agent) propagate
 * `agentMode: "scheduled"` to AgentLoop.run. Verified with a mock AgentLoop
 * that records the options of every call.
 */
import { describe, test, expect } from "bun:test";
import { installAutonomousScheduler } from "../src/app/schedulers";
import { installFreeAgentScheduler } from "../src/scheduler/free-agent";
import type { AppDeps } from "../src/app/deps";
import type { AgentLoopRequest, AgentLoopResult } from "../src/pipeline/agent-loop";

function makeMockAgentLoop() {
  const calls: AgentLoopRequest[] = [];
  const mock = {
    run: (req: AgentLoopRequest): Promise<AgentLoopResult> => {
      calls.push(req);
      return Promise.resolve({
        requestId: "req-mock",
        sessionId: req.sessionId ?? "sess-mock",
        steps: [],
        finalAnswer: "ok",
        totalSteps: 0,
        stoppedReason: "done",
      });
    },
    createStream: () => new ReadableStream<Uint8Array>(),
    setMetrics: () => {},
    setRoom: () => {},
  };
  return { mock, calls };
}

function waitForCall(calls: unknown[], timeoutMs = 500): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (calls.length > 0) return resolve();
      if (Date.now() > deadline) {
        return reject(new Error("mock agentLoop.run not invoked in time"));
      }
      setTimeout(poll, 5);
    };
    poll();
  });
}

describe("scheduler agentMode propagation (SCHED-1)", () => {
  test("installAutonomousScheduler passes agentMode:'scheduled'", async () => {
    const { mock, calls } = makeMockAgentLoop();
    const deps = {
      config: {
        autonomous: {
          enabled: true,
          intervalMinutes: 60,
          startupDelayMs: 1,
          maxSteps: 5,
          task: "test-task",
        },
      },
      agentLoop: mock,
    } as unknown as AppDeps;

    const handle = installAutonomousScheduler(deps);
    try {
      await waitForCall(calls);
      expect(calls.length).toBeGreaterThanOrEqual(1);
      expect(calls[0].agentMode).toBe("scheduled");
      expect(calls[0].task).toBe("test-task");
      expect(calls[0].schedule?.source).toBe("autonomous");
    } finally {
      handle.stop();
    }
  });

  test("installFreeAgentScheduler passes agentMode:'scheduled'", async () => {
    const { mock, calls } = makeMockAgentLoop();
    const deps = {
      config: {
        freeAgent: {
          enabled: true,
          intervalMinutes: 60,
          startupDelayMs: 1,
          maxSteps: 5,
          task: "free-test-task",
        },
      },
      agentLoop: mock,
      telegramBot: null,
    } as unknown as AppDeps;

    const handle = installFreeAgentScheduler(deps);
    try {
      await waitForCall(calls);
      expect(calls.length).toBeGreaterThanOrEqual(1);
      expect(calls[0].agentMode).toBe("scheduled");
      expect(calls[0].task).toBe("free-test-task");
      expect(calls[0].schedule?.source).toBe("free-agent");
    } finally {
      handle.stop();
    }
  });

  test("disabled scheduler never calls agentLoop.run", async () => {
    const { mock, calls } = makeMockAgentLoop();
    const deps = {
      config: {
        autonomous: {
          enabled: false,
          intervalMinutes: 60,
          startupDelayMs: 1,
          maxSteps: 5,
          task: "noop",
        },
      },
      agentLoop: mock,
    } as unknown as AppDeps;

    const handle = installAutonomousScheduler(deps);
    await new Promise((r) => setTimeout(r, 20));
    handle.stop();
    expect(calls.length).toBe(0);
  });
});
