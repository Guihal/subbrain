/**
 * Approval audit log helper.
 *
 * Writes a single metrics_log row with snapshot.kind="approval_decision"
 * for every approval state change (requested, approved, denied, expired).
 */
import type { Database } from "bun:sqlite";
import type { ApprovalStatus } from "../db/tables/approvals";

export interface ApprovalAuditSnapshot {
  kind: "approval_decision";
  approval_id: string;
  tool_name: string;
  status: ApprovalStatus;
  requested_at: number;
  resolved_at: number | null;
}

export function logApprovalDecision(
  db: Database,
  params: {
    approvalId: string;
    toolName: string;
    status: ApprovalStatus;
    requestedAt: number;
    resolvedAt?: number | null;
  },
): void {
  const snapshot: ApprovalAuditSnapshot = {
    kind: "approval_decision",
    approval_id: params.approvalId,
    tool_name: params.toolName,
    status: params.status,
    requested_at: params.requestedAt,
    resolved_at: params.resolvedAt ?? null,
  };
  db.query("INSERT INTO metrics_log (timestamp, snapshot) VALUES (unixepoch(), ?)").run(
    JSON.stringify(snapshot),
  );
}
