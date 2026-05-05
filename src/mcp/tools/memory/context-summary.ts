import type { MemoryDB } from "@subbrain/core/db";
import type { ToolResult } from "../../types";

export function contextSummary(memory: MemoryDB, sessionId: string): ToolResult {
  const logs = memory.getLogsBySession(sessionId, 50);
  const focus = memory.getAllFocus();

  return {
    success: true,
    data: {
      focus,
      recent_log_count: logs.length,
      recent_logs: logs.slice(0, 10).map((l) => ({
        role: l.role,
        content: l.content.substring(0, 200),
        agent_id: l.agent_id,
      })),
    },
  };
}
