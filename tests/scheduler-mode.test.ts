/**
 * SCHED-1: scheduler entrypoints (AUTONOMOUS loop + free-agent) propagate
 * `agentMode: "scheduled"` through AgentService.run (PR 26b LAYER-4). Verified
 * with a mock AgentService that records the options of every call.
 */
import { describe, expect, test } from "bun:test";
import type { AgentLoopResult } from "@subbrain/agent/pipeline/agent-loop";
import { installFreeAgentScheduler } from "@subbrain/agent/scheduler/free-agent";
import type { AgentRunOpts } from "@subbrain/agent/services/agent.service";
import type { AppDeps } from "@subbrain/server/app/deps";
import { installAutonomousScheduler } from "@subbrain/server/app/schedulers";

function makeMockAgentService() {
  const calls: AgentRunOpts[] = [];
  const mock = {
    run: (opts: AgentRunOpts): Promise<AgentLoopResult> => {
      calls.push(opts);
      return Promise.resolve({
        requestId: "req-mock",
        sessionId: opts.sessionId ?? "sess-mock",
        steps: [],
        finalAnswer: "ok",
        totalSteps: 0,
        stoppedReason: "done",
      });
    },
    createStream: () => new ReadableStream<Uint8Array>(),
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
    const { mock, calls } = makeMockAgentService();
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
      agentService: mock,
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
    const { mock, calls } = makeMockAgentService();
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
      agentService: mock,
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

  test("disabled scheduler never calls agentService.run", async () => {
    const { mock, calls } = makeMockAgentService();
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
      agentService: mock,
    } as unknown as AppDeps;

    const handle = installAutonomousScheduler(deps);
    await new Promise((r) => setTimeout(r, 20));
    handle.stop();
    expect(calls.length).toBe(0);
  });
});
