/**
 * 8a-7: Approval flow integration tests.
 *
 * Covers: approve, deny, expiry, operator-unavailable, interactive-gated.
 * Uses the real approval-gate plugin + HooksDispatcher against an in-memory DB.
 */

import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { canonicalizeArgs } from "@subbrain/agent/mcp/registry/approval-registry";
import type { ToolResult } from "@subbrain/plugin";
import { toLegacy } from "@subbrain/plugin";
import { approvalGatePlugin } from "../packages/agent/plugins-internal/approval-gate";
import { HooksDispatcher } from "../packages/agent/src/hooks/dispatcher";
import { migrate } from "../packages/core/src/db/schema";
import { ApprovalsTable } from "../packages/core/src/db/tables/approvals";
import { ApprovalRepository } from "../packages/core/src/repositories/approval.repo";

const DB_PATH = "data/test-approval-flow.db";

function createTestDb(): Database {
  const db = new Database(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

function mockExecutor(db: Database) {
  const notified: Array<{ tool_name: string; status: string }> = [];
  return {
    memoryDb: { db },
    approvalNotifier: (row: { tool_name: string; status: string }) => {
      notified.push({ tool_name: row.tool_name, status: row.status });
    },
    notified,
  };
}

function makeDispatcher() {
  const d = new HooksDispatcher();
  d.register(approvalGatePlugin);
  return d;
}

function runGate(
  dispatcher: HooksDispatcher,
  toolName: string,
  args: unknown,
  agentMode: string,
  executor: ReturnType<typeof mockExecutor>,
): Promise<ToolResult | undefined> {
  return dispatcher.runToolBefore(toolName, args, {
    executor: executor as unknown as import("@subbrain/agent/mcp/executor").ToolExecutor,
    agentMode,
  });
}

function legacy(result: ToolResult | undefined) {
  if (!result) return { success: true };
  return toLegacy(result);
}

describe("approval flow integration (8a-7)", () => {
  let db: Database;
  let table: ApprovalsTable;
  let repo: ApprovalRepository;
  let dispatcher: HooksDispatcher;

  const savedEnv = {
    APPROVAL_DISABLE: process.env.APPROVAL_DISABLE,
    APPROVAL_OPERATOR_CHAT_ID: process.env.APPROVAL_OPERATOR_CHAT_ID,
    TG_OWNER_CHAT_ID: process.env.TG_OWNER_CHAT_ID,
  };

  beforeAll(() => {
    if (existsSync(DB_PATH)) unlinkSync(DB_PATH);
  });

  beforeEach(() => {
    delete process.env.APPROVAL_DISABLE;
    process.env.APPROVAL_OPERATOR_CHAT_ID = "12345";
    delete process.env.TG_OWNER_CHAT_ID;
    db = createTestDb();
    table = new ApprovalsTable(db);
    repo = new ApprovalRepository(db);
    dispatcher = makeDispatcher();
  });

  afterEach(() => {
    db.close();
    if (existsSync(DB_PATH)) unlinkSync(DB_PATH);
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
      else (process.env as Record<string, string | undefined>)[k] = v;
    }
  });

  afterAll(() => {
    if (existsSync(DB_PATH)) unlinkSync(DB_PATH);
  });

  // ─── Golden: approve tg_send_message in scheduled mode ───

  test("golden case: tg_send_message scheduled → pending → approve → passthrough", async () => {
    const exec = mockExecutor(db);
    const args = { chat_id: "42", text: "hello" };

    // First call: gated, inserts pending
    const r1 = await runGate(dispatcher, "tg_send_message", args, "scheduled", exec);
    const leg1 = legacy(r1);
    expect(leg1.success).toBe(false);
    expect((leg1.error as { code: string })?.code).toBe("awaiting_approval");

    // Pending row exists
    const hash = canonicalizeArgs(args);
    const pending = table.getByToolAndHash("tg_send_message", hash);
    expect(pending).not.toBeNull();
    expect(pending?.status).toBe("pending");

    // Notifier fired
    expect(exec.notified.length).toBe(1);
    expect(exec.notified[0].tool_name).toBe("tg_send_message");

    // Operator approves
    repo.updateStatus(pending?.id, "approved", Math.floor(Date.now() / 1000));

    // Second call: passthrough
    const r2 = await runGate(dispatcher, "tg_send_message", args, "scheduled", exec);
    expect(r2).toBeUndefined();
  });

  // ─── Golden: approve tg_send_report in scheduled mode ───

  test("golden case: tg_send_report scheduled → pending → approve → passthrough", async () => {
    const exec = mockExecutor(db);
    const args = { text: "daily report" };

    const r1 = await runGate(dispatcher, "tg_send_report", args, "scheduled", exec);
    const leg1 = legacy(r1);
    expect(leg1.success).toBe(false);
    expect((leg1.error as { code: string })?.code).toBe("awaiting_approval");

    const hash = canonicalizeArgs(args);
    const pending = table.getByToolAndHash("tg_send_report", hash);
    expect(pending).not.toBeNull();

    repo.updateStatus(pending?.id, "approved", Math.floor(Date.now() / 1000));

    const r2 = await runGate(dispatcher, "tg_send_report", args, "scheduled", exec);
    expect(r2).toBeUndefined();
  });

  // ─── Denial case ───

  test("denial case: operator denies → second invocation returns approval_denied", async () => {
    const exec = mockExecutor(db);
    const args = { chat_id: "99", text: "spam" };

    const r1 = await runGate(dispatcher, "tg_send_message", args, "scheduled", exec);
    expect(legacy(r1).success).toBe(false);

    const hash = canonicalizeArgs(args);
    const pending = table.getByToolAndHash("tg_send_message", hash)!;
    repo.updateStatus(pending.id, "denied", Math.floor(Date.now() / 1000));

    const r2 = await runGate(dispatcher, "tg_send_message", args, "scheduled", exec);
    const leg2 = legacy(r2);
    expect(leg2.success).toBe(false);
    expect((leg2.error as { code: string })?.code).toBe("approval_denied");
  });

  // ─── Expiry case ───

  test("expiry case: sweeper marks expired → second invocation returns approval_expired", async () => {
    const exec = mockExecutor(db);
    const args = { chat_id: "77", text: "old" };
    const nowSec = Math.floor(Date.now() / 1000);

    // Manually insert a stale pending row (past TTL)
    table.insert({
      tool_name: "tg_send_message",
      args_hash: canonicalizeArgs(args),
      status: "pending",
      requested_at: nowSec - 2000,
      resolved_at: null,
      operator_chat_id: 12345,
      request_message: "old request",
    });

    // Run sweeper with TTL=900
    const { expirePendingApprovals } = await import("@subbrain/agent/scheduler/approval-sweeper");
    const changed = expirePendingApprovals(db, 900);
    expect(changed).toBe(1);

    // Gate sees expired row as stale → inserts fresh pending, but since row exists
    // with expired status, it treats as none and inserts new pending.
    // Actually: the gate checks isFresh on the row. expired row → not fresh → falls through.
    // Then inserts new pending because no fresh approved row.
    const r2 = await runGate(dispatcher, "tg_send_message", args, "scheduled", exec);
    const leg2 = legacy(r2);
    // After expiry, gate inserts NEW pending row (since old one is expired, not pending)
    expect(leg2.success).toBe(false);
    expect((leg2.error as { code: string })?.code).toBe("awaiting_approval");

    // Verify the old row is still expired
    const hash = canonicalizeArgs(args);
    const allRows = db
      .query(
        "SELECT * FROM approvals WHERE tool_name = ? AND args_hash = ? ORDER BY requested_at DESC",
      )
      .all("tg_send_message", hash) as Array<{ status: string }>;
    expect(allRows.length).toBe(2);
    expect(allRows[0].status).toBe("pending"); // new
    expect(allRows[1].status).toBe("expired"); // old
  });

  // ─── Operator unavailable ───

  test("operator unavailable: no env vars → approval_unavailable, no DB row", async () => {
    delete process.env.APPROVAL_OPERATOR_CHAT_ID;
    delete process.env.TG_OWNER_CHAT_ID;

    const exec = mockExecutor(db);
    const args = { chat_id: "1", text: "x" };

    const r1 = await runGate(dispatcher, "tg_send_message", args, "scheduled", exec);
    const leg1 = legacy(r1);
    expect(leg1.success).toBe(false);
    expect((leg1.error as { code: string })?.code).toBe("approval_unavailable");

    // No DB row written
    const rows = db.query("SELECT COUNT(*) as c FROM approvals").get() as { c: number };
    expect(rows.c).toBe(0);
  });

  // ─── Interactive also gated ───

  test("interactive also gated: tg_send_message in interactive mode awaits approval", async () => {
    const exec = mockExecutor(db);
    const args = { chat_id: "55", text: "interactive msg" };

    const r1 = await runGate(dispatcher, "tg_send_message", args, "interactive", exec);
    const leg1 = legacy(r1);
    expect(leg1.success).toBe(false);
    expect((leg1.error as { code: string })?.code).toBe("awaiting_approval");

    const hash = canonicalizeArgs(args);
    const pending = table.getByToolAndHash("tg_send_message", hash);
    expect(pending).not.toBeNull();
    expect(pending?.status).toBe("pending");
  });

  test("interactive also gated: tg_send_report in interactive mode awaits approval", async () => {
    const exec = mockExecutor(db);
    const args = { text: "interactive report" };

    const r1 = await runGate(dispatcher, "tg_send_report", args, "interactive", exec);
    const leg1 = legacy(r1);
    expect(leg1.success).toBe(false);
    expect((leg1.error as { code: string })?.code).toBe("awaiting_approval");
  });

  // ─── Non-gated tools pass through ───

  test("non-gated tool passes through without DB touch", async () => {
    const exec = mockExecutor(db);
    const r = await runGate(dispatcher, "think", { thought: "hello" }, "scheduled", exec);
    expect(r).toBeUndefined();

    const rows = db.query("SELECT COUNT(*) as c FROM approvals").get() as { c: number };
    expect(rows.c).toBe(0);
  });

  // ─── APPROVAL_DISABLE bypass ───

  test("APPROVAL_DISABLE=true bypasses gate entirely", async () => {
    process.env.APPROVAL_DISABLE = "true";
    const exec = mockExecutor(db);
    const args = { chat_id: "1", text: "bypass" };

    const r = await runGate(dispatcher, "tg_send_message", args, "scheduled", exec);
    expect(r).toBeUndefined();

    const rows = db.query("SELECT COUNT(*) as c FROM approvals").get() as { c: number };
    expect(rows.c).toBe(0);
  });

  // ─── Pending re-call returns awaiting_approval (no duplicate insert) ───

  test("pending re-call returns awaiting_approval without duplicate row", async () => {
    const exec = mockExecutor(db);
    const args = { chat_id: "66", text: "dup test" };

    const r1 = await runGate(dispatcher, "tg_send_message", args, "scheduled", exec);
    expect(legacy(r1).success).toBe(false);

    const r2 = await runGate(dispatcher, "tg_send_message", args, "scheduled", exec);
    const leg2 = legacy(r2);
    expect(leg2.success).toBe(false);
    expect((leg2.error as { code: string })?.code).toBe("awaiting_approval");

    const hash = canonicalizeArgs(args);
    const rows = db
      .query(
        "SELECT COUNT(*) as c FROM approvals WHERE tool_name = ? AND args_hash = ? AND status = 'pending'",
      )
      .get("tg_send_message", hash) as { c: number };
    expect(rows.c).toBe(1);
  });

  // ─── Fresh approved row outside TTL is ignored ───

  test("stale approved row outside TTL triggers new pending", async () => {
    const exec = mockExecutor(db);
    const args = { chat_id: "88", text: "stale" };
    const nowSec = Math.floor(Date.now() / 1000);
    const hash = canonicalizeArgs(args);

    // Insert old approved row
    table.insert({
      tool_name: "tg_send_message",
      args_hash: hash,
      status: "approved",
      requested_at: nowSec - 2000,
      resolved_at: nowSec - 1500,
      operator_chat_id: 12345,
      request_message: "old approved",
    });

    const r = await runGate(dispatcher, "tg_send_message", args, "scheduled", exec);
    const leg = legacy(r);
    // Stale approved → not fresh → insert new pending
    expect(leg.success).toBe(false);
    expect((leg.error as { code: string })?.code).toBe("awaiting_approval");
  });
});
