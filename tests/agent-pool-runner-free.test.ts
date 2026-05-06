import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { MemoryDB } from "@subbrain/core/db";
import { AgentLoop } from "@subbrain/agent/pipeline/agent-loop";
import { ModelRouter } from "@subbrain/core/lib/model-router";
import { buildRegistry, PlaywrightClient, ToolExecutor } from "@subbrain/agent/mcp";
import { RAGPipeline } from "@subbrain/agent/rag";
import { ArbitrationRoom } from "@subbrain/agent/pipeline/arbitration";
import { runFreeTask } from "@subbrain/agent/scheduler/agent-pool/runners/free";
import type { AgentTaskRecord } from "@subbrain/core/db/tables/agent-tasks/types";
import type { Message, ToolCall, Tool } from "@subbrain/providers/types";

const TEST_DB = "data/test-agent-pool-runner.db";

function cleanup(): void {
  for (const ext of ["", "-shm", "-wal"]) {
    const p = `${TEST_DB}${ext}`;
    if (existsSync(p)) unlinkSync(p);
  }
}

describe("agent-pool runner free", () => {
  let db: MemoryDB;
  let agentLoop: AgentLoop;
  let router: ModelRouter;

  beforeEach(async () => {
    cleanup();
    db = new MemoryDB(TEST_DB);
    // Stub router that immediately returns a done_with_artifact tool call.
    router = new ModelRouter([]);
    let stepCount = 0;
    router.chat = async (_model, params, _priority) => {
      stepCount++;
      const messages = params.messages as Message[];
      // If token budget abort fired, signal is aborted — but we can't easily
      // detect that here. Instead we rely on the test env cap=100 to trigger
      // abort after first onUsage callback. For the mock, we just return
      // done_with_artifact on step 1; the abort test uses a separate path.
      const tc: ToolCall = {
        id: "tc1",
        type: "function",
        function: {
          name: "done_with_artifact",
          arguments: JSON.stringify({
            status: "complete",
            artifact: JSON.stringify({ type: "test", content: "ok" }),
          }),
        },
      };
      return {
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [tc],
            },
            finish_reason: "tool_calls",
            index: 0,
          },
        ],
        usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
      };
    };
    const registry = buildRegistry();
    const tools = new ToolExecutor(db, router);
    const rag = new RAGPipeline(db, router);
    tools.setRAG(rag);
    const playwright = new PlaywrightClient();
    tools.setPlaywright(playwright);
    const room = new ArbitrationRoom(router);
    agentLoop = new AgentLoop(db, router, rag, tools, registry);
    agentLoop.setRoom(room);
  });

  afterEach(() => {
    db.close();
    cleanup();
  });

  function makeTask(prompt: string): AgentTaskRecord {
    return {
      id: 1,
      type: "free",
      prompt,
      status: "pending",
      priority: 1,
      scheduledAt: null,
      startedAt: null,
      finishedAt: null,
      artifact: null,
      reason: null,
      createdBy: "test",
      createdAt: Math.floor(Date.now() / 1000),
    };
  }

  test("returns complete with parsed artifact", async () => {
    const task = makeTask("do it");
    const result = await runFreeTask(agentLoop, task);
    expect(result.status).toBe("complete");
    expect(result.artifact).toEqual({ type: "test", content: "ok" });
  });

  test("token budget abort returns failed with token_budget_exceeded", async () => {
    const task = makeTask("do nothing");
    process.env.AGENT_POOL_MAX_TOKENS_FREE = "50";
    // Override router to simulate slow burn that exceeds budget.
    let callCount = 0;
    router.chat = async (_model, params, _priority) => {
      callCount++;
      if (callCount > 1) {
        // After abort, signal should be aborted; but we just throw to simulate.
        throw new Error("AbortError: token_budget_exceeded");
      }
      const tc: ToolCall = {
        id: "tc1",
        type: "function",
        function: {
          name: "web_navigate",
          arguments: JSON.stringify({ url: "http://example.com" }),
        },
      };
      return {
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [tc],
            },
            finish_reason: "tool_calls",
            index: 0,
          },
        ],
        usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 },
      };
    };
    const result = await runFreeTask(agentLoop, task);
    delete process.env.AGENT_POOL_MAX_TOKENS_FREE;
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("token_budget_exceeded");
  });

  test("system prompt does not contain anti-economy phrases", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      "packages/agent/src/scheduler/agent-pool/runners/free.ts",
      "utf-8",
    );
    const banned = /save tokens|be efficient|постарайся уложиться|не используй tool без нужды/gi;
    expect(src.match(banned)).toBeNull();
  });
});
