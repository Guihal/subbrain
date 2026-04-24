/**
 * SCHED-1: `buildAgentSystemPrompt(..., agentMode)` gates the Code Tools
 * authoring section behind `interactive` (default) — scheduled mode renders
 * only a short disable notice and never mentions `create_code_tool`.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { unlinkSync } from "node:fs";
import { MemoryDB } from "../src/db";
import { buildAgentSystemPrompt } from "../src/pipeline/agent-loop/system-prompt";
import type { RAGPipeline } from "../src/rag";

const TEST_DB = "data/test-system-prompt-mode.db";
try {
  unlinkSync(TEST_DB);
} catch {}

const memory = new MemoryDB(TEST_DB);

// Minimal RAG stub — legacy path (no router) only calls `.search()`.
const ragStub: Pick<RAGPipeline, "search"> = {
  search: async () => [],
};

afterAll(() => {
  memory.close();
  try {
    unlinkSync(TEST_DB);
  } catch {}
});

describe("buildAgentSystemPrompt agentMode (SCHED-1)", () => {
  test("interactive mode includes Code Tools authoring section", async () => {
    const prompt = await buildAgentSystemPrompt(
      memory,
      ragStub as RAGPipeline,
      "test task",
      "teamlead",
      undefined,
      undefined,
      "interactive",
    );
    expect(prompt).toContain("create_code_tool");
    expect(prompt).toContain("edit_code_tool");
    expect(prompt).toContain("Code Tools (исполняемый код)");
    expect(prompt).not.toContain("Code tools creation disabled");
  });

  test("scheduled mode strips Code Tools authoring section", async () => {
    const prompt = await buildAgentSystemPrompt(
      memory,
      ragStub as RAGPipeline,
      "test task",
      "teamlead",
      undefined,
      undefined,
      "scheduled",
    );
    expect(prompt).not.toContain("create_code_tool");
    expect(prompt).not.toContain("edit_code_tool");
    expect(prompt).not.toContain("Code Tools (исполняемый код)");
    expect(prompt).toContain("Code tools creation disabled");
  });

  test("default mode (unset) falls back to interactive", async () => {
    const prompt = await buildAgentSystemPrompt(
      memory,
      ragStub as RAGPipeline,
      "test task",
      "teamlead",
    );
    expect(prompt).toContain("create_code_tool");
    expect(prompt).not.toContain("Code tools creation disabled");
  });

  test("SCHEDULED_ALLOW_CODE_TOOL_CREATE=1 restores authoring under scheduled", async () => {
    const saved = process.env.SCHEDULED_ALLOW_CODE_TOOL_CREATE;
    process.env.SCHEDULED_ALLOW_CODE_TOOL_CREATE = "1";
    try {
      const prompt = await buildAgentSystemPrompt(
        memory,
        ragStub as RAGPipeline,
        "test task",
        "teamlead",
        undefined,
        undefined,
        "scheduled",
      );
      expect(prompt).toContain("create_code_tool");
      expect(prompt).not.toContain("Code tools creation disabled");
    } finally {
      if (saved === undefined) {
        delete process.env.SCHEDULED_ALLOW_CODE_TOOL_CREATE;
      } else {
        process.env.SCHEDULED_ALLOW_CODE_TOOL_CREATE = saved;
      }
    }
  });
});
