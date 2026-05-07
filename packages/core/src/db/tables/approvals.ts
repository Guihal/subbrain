import type { Database } from "bun:sqlite";

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export interface ApprovalRow {
  id: string;
  tool_name: string;
  args_hash: string;
  status: ApprovalStatus;
  requested_at: number;
  resolved_at: number | null;
  operator_chat_id: number | null;
  request_message: string;
}

export class ApprovalsTable {
  constructor(private db: Database) {}

  insert(row: Omit<ApprovalRow, "id">): string {
    const id = crypto.randomUUID();
    this.db
      .query(
        `INSERT INTO approvals (id, tool_name, args_hash, status, requested_at, resolved_at, operator_chat_id, request_message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        row.tool_name,
        row.args_hash,
        row.status,
        row.requested_at,
        row.resolved_at,
        row.operator_chat_id,
        row.request_message,
      );
    return id;
  }

  getById(id: string): ApprovalRow | null {
    return this.db.query("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow | null;
  }

  getByToolAndHash(toolName: string, argsHash: string): ApprovalRow | null {
    return this.db
      .query(
        "SELECT * FROM approvals WHERE tool_name = ? AND args_hash = ? ORDER BY requested_at DESC LIMIT 1",
      )
      .get(toolName, argsHash) as ApprovalRow | null;
  }

  updateStatus(id: string, status: ApprovalStatus, resolvedAt: number): number {
    return this.db
      .query(
        "UPDATE approvals SET status = ?, resolved_at = ? WHERE id = ? AND resolved_at IS NULL",
      )
      .run(status, resolvedAt, id).changes;
  }

  listPending(limit: number): ApprovalRow[] {
    return this.db
      .query("SELECT * FROM approvals WHERE status = 'pending' ORDER BY requested_at DESC LIMIT ?")
      .all(limit) as ApprovalRow[];
  }
}
