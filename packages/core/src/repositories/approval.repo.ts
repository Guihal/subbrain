/**
 * ApprovalRepository — PR 27 (LAYER-5). Wraps `ApprovalsTable`.
 * SQL only, no business logic.
 */
import type { Database } from "bun:sqlite";
import type { ApprovalRow, ApprovalStatus } from "../db/tables/approvals";
import { ApprovalsTable } from "../db/tables/approvals";

export class ApprovalRepository {
  private readonly table: ApprovalsTable;

  constructor(db: Database) {
    this.table = new ApprovalsTable(db);
  }

  create = (row: Omit<ApprovalRow, "id">): string => this.table.insert(row);

  getById = (id: string): ApprovalRow | null => this.table.getById(id);

  getByToolAndHash = (toolName: string, argsHash: string): ApprovalRow | null =>
    this.table.getByToolAndHash(toolName, argsHash);

  updateStatus = (id: string, status: ApprovalStatus, resolvedAt: number): number =>
    this.table.updateStatus(id, status, resolvedAt);

  listPending = (limit: number): ApprovalRow[] => this.table.listPending(limit);
}
