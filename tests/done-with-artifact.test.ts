/**
 * Tests for done_with_artifact MCP tool (P2-4).
 */
import { describe, expect, test, beforeEach } from "bun:test";
import {
  doneWithArtifact,
  resetTermination,
  isTerminated,
} from "@subbrain/agent/mcp/tools/pool/done-with-artifact";

describe("done_with_artifact validation", () => {
  beforeEach(() => resetTermination());

  test("complete with artifact → success", () => {
    const r = doneWithArtifact({ status: "complete", artifact: "result.json" });
    expect(r.success).toBe(true);
    expect((r as { data: Record<string, unknown> }).data).toEqual({
      status: "complete",
      artifact: "result.json",
    });
    expect(isTerminated()).toBe(true);
  });

  test("noop without artifact/reason → success", () => {
    const r = doneWithArtifact({ status: "noop" });
    expect(r.success).toBe(true);
    expect((r as { data: Record<string, unknown> }).data).toEqual({ status: "noop" });
    expect(isTerminated()).toBe(true);
  });

  test("failed with reason → success", () => {
    const r = doneWithArtifact({ status: "failed", reason: "network error" });
    expect(r.success).toBe(true);
    expect((r as { data: Record<string, unknown> }).data).toEqual({
      status: "failed",
      reason: "network error",
    });
    expect(isTerminated()).toBe(true);
  });

  test("complete without artifact → rejected", () => {
    const r = doneWithArtifact({ status: "complete" });
    expect(r.success).toBe(false);
    expect((r as { error: { code: string } }).error.code).toBe("missing_artifact");
    expect(isTerminated()).toBe(false);
  });

  test("complete with empty artifact → rejected", () => {
    const r = doneWithArtifact({ status: "complete", artifact: "   " });
    expect(r.success).toBe(false);
    expect((r as { error: { code: string } }).error.code).toBe("missing_artifact");
  });

  test("failed without reason → rejected", () => {
    const r = doneWithArtifact({ status: "failed" });
    expect(r.success).toBe(false);
    expect((r as { error: { code: string } }).error.code).toBe("missing_reason");
    expect(isTerminated()).toBe(false);
  });

  test("failed with empty reason → rejected", () => {
    const r = doneWithArtifact({ status: "failed", reason: "" });
    expect(r.success).toBe(false);
    expect((r as { error: { code: string } }).error.code).toBe("missing_reason");
  });

  test("second invocation → already_terminated", () => {
    doneWithArtifact({ status: "noop" });
    const r = doneWithArtifact({ status: "noop" });
    expect(r.success).toBe(false);
    expect((r as { error: { code: string } }).error.code).toBe("already_terminated");
  });
});

describe("done_with_artifact registry integration", () => {
  test("tool registered with agent-only scope", async () => {
    const { buildRegistry } = await import("@subbrain/agent/mcp/registry");
    const registry = buildRegistry();
    const tool = registry.get("done_with_artifact");
    expect(tool).toBeDefined();
    expect(tool?.scope).toBe("agent-only");
    expect(tool?.name).toBe("done_with_artifact");
  });

  test("public listing excludes done_with_artifact", async () => {
    const { buildRegistry } = await import("@subbrain/agent/mcp/registry");
    const registry = buildRegistry();
    const publicNames = registry.listPublic().map((t) => t.name);
    expect(publicNames).not.toContain("done_with_artifact");
  });

  test("agent listing includes done_with_artifact", async () => {
    const { buildRegistry } = await import("@subbrain/agent/mcp/registry");
    const registry = buildRegistry();
    const agentNames = registry.listForAgent("interactive").map((t) => t.name);
    expect(agentNames).toContain("done_with_artifact");
  });
});

describe("done_with_artifact tool-dispatch integration", () => {
  test("runToolCall detects isDone for done_with_artifact", async () => {
    const { runToolCall } = await import("@subbrain/agent/pipeline/agent-loop/tool-dispatch");
    const mockLog = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    };
    const outcome = await runToolCall(
      {
        id: "call_1",
        type: "function",
        function: {
          name: "done_with_artifact",
          arguments: JSON.stringify({ status: "complete", artifact: "x" }),
        },
      },
      {} as any,
      mockLog as any,
    );
    expect(outcome.isDone).toBe(true);
  });
});

console.log("done_with_artifact tests loaded");
