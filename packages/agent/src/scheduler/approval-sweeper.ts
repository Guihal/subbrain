import type { Database } from "bun:sqlite";
import { logger } from "@subbrain/core/lib/logger";
import { logApprovalDecision } from "@subbrain/core/lib/approval-audit";

const APPROVAL_SWEEP_MS = Number(process.env.APPROVAL_SWEEP_MS ?? "60000");

export function expirePendingApprovals(db: Database, ttlSec: number): number {
  const tx = db.transaction(() => {
    const nowSec = Math.floor(Date.now() / 1000);
    const expired = db
      .query<
        { id: string; tool_name: string; requested_at: number },
        [number, number]
      >(
        `SELECT id, tool_name, requested_at FROM approvals
         WHERE status = 'pending' AND (requested_at + ?) < ?`,
      )
      .all(ttlSec, nowSec);

    for (const row of expired) {
      db.query("UPDATE approvals SET status = 'expired', resolved_at = ? WHERE id = ?").run(
        nowSec,
        row.id,
      );
      logApprovalDecision(db, {
        approvalId: row.id,
        toolName: row.tool_name,
        status: "expired",
        requestedAt: row.requested_at,
        resolvedAt: nowSec,
      });
    }
    return expired.length;
  });
  return tx();
}

export class ApprovalSweeper {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly db: Database;
  private readonly ttlSec: number;

  constructor(deps: { db: Database; ttlSec?: number }) {
    this.db = deps.db;
    this.ttlSec = deps.ttlSec ?? Number(process.env.APPROVAL_TTL_SEC ?? "900");
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), APPROVAL_SWEEP_MS);
    this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    const count = expirePendingApprovals(this.db, this.ttlSec);
    if (count > 0) {
      logger.info("approval-sweeper", "expired N pending approvals", {
        meta: { count },
      });
    }
  }
}
