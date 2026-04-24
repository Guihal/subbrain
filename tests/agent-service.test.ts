/**
 * AgentService unit tests (PR 26b — LAYER-4 services split).
 *
 * Asserts the service passes `agentMode` verbatim to AgentLoop.run /
 * createStream, applies the documented defaults (model=teamlead,
 * priority=low), and forwards optional fields. Pure stubs — no real loop.
 */
import { describe, test, expect } from "bun:test";
import { AgentService } from "../src/services/agent.service";
import type { AgentLoop, AgentLoopRequest, AgentLoopResult } from "../src/pipeline/agent-loop";
import type { ChatRepository } from "../src/repositories";

function makeMockLoop() {
  const runCalls: AgentLoopRequest[] = [];
  const streamCalls: AgentLoopRequest[] = [];
  const loop = {
    run: (req: AgentLoopRequest): Promise<AgentLoopResult> => {
      runCalls.push(req);
      return Promise.resolve({
        requestId: "req-mock",
        sessionId: req.sessionId ?? "sess-mock",
        steps: [],
        finalAnswer: "ok",
        totalSteps: 0,
        stoppedReason: "done",
      });
    },
    createStream: (req: AgentLoopRequest): ReadableStream<Uint8Array> => {
      streamCalls.push(req);
      return new ReadableStream<Uint8Array>({
        start(c) { c.close(); },
      });
    },
    setMetrics: () => {},
    setRoom: () => {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as unknown as AgentLoop;
  return { loop, runCalls, streamCalls };
}

const memoryStub = {} as ChatRepository;

describe("AgentService.run", () => {
  test("forwards agentMode='scheduled' + fills defaults (model=teamlead, priority=low)", async () => {
    const { loop, runCalls } = makeMockLoop();
    const svc = new AgentService(loop, memoryStub);
    const r = await svc.run({ task: "X", agentMode: "scheduled" });
    expect(r.stoppedReason).toBe("done");
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0].agentMode).toBe("scheduled");
    expect(runCalls[0].task).toBe("X");
    expect(runCalls[0].model).toBe("teamlead");
    expect(runCalls[0].priority).toBe("low");
  });

  test("forwards agentMode='interactive' + explicit model/maxSteps override defaults", async () => {
    const { loop, runCalls } = makeMockLoop();
    const svc = new AgentService(loop, memoryStub);
    await svc.run({
      task: "Y",
      agentMode: "interactive",
      model: "coder",
      maxSteps: 12,
      sessionId: "sess-42",
    });
    expect(runCalls[0]).toMatchObject({
      task: "Y",
      model: "coder",
      maxSteps: 12,
      sessionId: "sess-42",
      agentMode: "interactive",
      priority: "low",
    });
  });

  test("propagates schedule context when provided", async () => {
    const { loop, runCalls } = makeMockLoop();
    const svc = new AgentService(loop, memoryStub);
    await svc.run({
      task: "Z",
      agentMode: "scheduled",
      schedule: { intervalMinutes: 30, source: "autonomous" },
    });
    expect(runCalls[0].schedule).toEqual({
      intervalMinutes: 30,
      source: "autonomous",
    });
  });
});

describe("AgentService.createStream", () => {
  test("returns a ReadableStream and forwards agentMode", () => {
    const { loop, streamCalls } = makeMockLoop();
    const svc = new AgentService(loop, memoryStub);
    const stream = svc.createStream({ task: "S", agentMode: "interactive" });
    expect(stream).toBeInstanceOf(ReadableStream);
    expect(streamCalls).toHaveLength(1);
    expect(streamCalls[0].agentMode).toBe("interactive");
    expect(streamCalls[0].model).toBe("teamlead");
  });
});
