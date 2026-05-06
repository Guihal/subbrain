import type { AgentTaskRecord, AgentTaskStatus, AgentTaskType } from "@subbrain/core/db/tables/agent-tasks/types";

interface Rollup {
  type: AgentTaskType;
  done: number;
  failed: number;
  noop: number;
  pending: number;
}

export function composeDailyRollup(records: AgentTaskRecord[]): string {
  const map = new Map<AgentTaskType, Rollup>();
  for (const r of records) {
    let row = map.get(r.type);
    if (!row) {
      row = { type: r.type, done: 0, failed: 0, noop: 0, pending: 0 };
      map.set(r.type, row);
    }
    inc(row, r.status);
  }
  const rows = Array.from(map.values()).sort((a, b) => a.type.localeCompare(b.type));
  if (rows.length === 0) return "*No tasks in the last 24h.*";

  const lines: string[] = ["*Agent Pool — 24h Rollup*", ""];
  for (const r of rows) {
    lines.push(`\`${r.type}\`: ✅ ${r.done} | ❌ ${r.failed} | ⏭ ${r.noop} | ⏳ ${r.pending}`);
  }
  return lines.join("\n");
}

export function composeInstantAlert(record: AgentTaskRecord): string {
  return `🚨 Task #${record.id} (${record.type}) failed: ${record.reason ?? "unknown"}`;
}

function inc(row: Rollup, status: AgentTaskStatus): void {
  if (status === "done") row.done++;
  else if (status === "failed") row.failed++;
  else if (status === "noop") row.noop++;
  else if (status === "pending") row.pending++;
}
