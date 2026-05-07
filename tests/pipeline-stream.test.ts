/**
 * AgentPipeline streaming + sessionId preservation.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AgentPipeline } from "@subbrain/agent/pipeline";
import { setupPipeline, teardown } from "./lib/pipeline-mocks";

const TEST_DB = "data/test-pipeline-stream.db";

let pipeline: AgentPipeline;

beforeAll(() => {
  pipeline = setupPipeline(TEST_DB).pipeline;
});

afterAll(() => teardown(TEST_DB));

describe("AgentPipeline streaming + session", () => {
  test("streaming response yields chunks", async () => {
    const r = await pipeline.execute({
      model: "teamlead",
      messages: [
        {
          role: "user",
          content: "Why did we choose Bun and Elysia for the performance of the server runtime?",
        },
      ],
      stream: true,
    });
    expect(r.stream).toBeDefined();
    expect(r.response).toBeUndefined();
    expect(r.requestId.length).toBeGreaterThan(0);
    const reader = r.stream?.getReader();
    if (!reader) throw new Error("expected stream reader");
    const chunks: string[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(new TextDecoder().decode(value));
    }
    expect(chunks.length).toBeGreaterThan(0);
  });

  test("explicit sessionId is preserved", async () => {
    const r = await pipeline.execute({
      model: "coder",
      messages: [
        { role: "assistant", content: "prev" },
        { role: "user", content: "More code please" },
      ],
      sessionId: "my-session-123",
    });
    expect(r.sessionId).toBe("my-session-123");
  });
});
