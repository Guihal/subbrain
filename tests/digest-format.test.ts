import { describe, expect, test } from "bun:test";
import { composeDailyRollup, composeInstantAlert } from "@subbrain/agent/scheduler/agent-pool/digest";
import type { AgentTaskRecord } from "@subbrain/core/db/tables/agent-tasks/types";

function makeRecord(id: number, type: AgentTaskRecord["type"], status: AgentTaskRecord["status"], reason?: string): AgentTaskRecord {
  return {
    id,
    type,
    prompt: "p",
    status,
    priority: 1,
    scheduledAt: null,
    startedAt: null,
    finishedAt: null,
    artifact: null,
    reason: reason ?? null,
    createdBy: "test",
    createdAt: 0,
  };
}

describe("digest format", () => {
  test("composeDailyRollup empty", () => {
    expect(composeDailyRollup([])).toBe("*No tasks in the last 24h.*");
  });

  test("composeDailyRollup aggregates by type", () => {
    const records = [
      makeRecord(1, "free", "done"),
      makeRecord(2, "free", "done"),
      makeRecord(3, "free", "failed"),
      makeRecord(4, "scheduled", "noop"),
      makeRecord(5, "scheduled", "pending"),
    ];
    const out = composeDailyRollup(records);
    expect(out).toContain("Agent Pool — 24h Rollup");
    expect(out).toContain("`free`: ✅ 2 | ❌ 1 | ⏭ 0 | ⏳ 0");
    expect(out).toContain("`scheduled`: ✅ 0 | ❌ 0 | ⏭ 1 | ⏳ 1");
  });

  test("composeDailyRollup sorts types alphabetically", () => {
    const records = [
      makeRecord(1, "scheduled", "done"),
      makeRecord(2, "free", "done"),
    ];
    const out = composeDailyRollup(records);
    const freeIdx = out.indexOf("`free`");
    const schedIdx = out.indexOf("`scheduled`");
    expect(freeIdx).toBeLessThan(schedIdx);
  });

  test("composeInstantAlert formats failed task", () => {
    const r = makeRecord(7, "free", "failed", "oom");
    expect(composeInstantAlert(r)).toBe("🚨 Task #7 (free) failed: oom");
  });

  test("composeInstantAlert handles null reason", () => {
    const r = makeRecord(3, "scheduled", "failed");
    expect(composeInstantAlert(r)).toBe("🚨 Task #3 (scheduled) failed: unknown");
  });
});
