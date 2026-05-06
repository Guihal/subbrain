import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../packages/core/src/db/schema";
import { ApprovalsTable } from "../packages/core/src/db/tables/approvals";
import { ApprovalRepository } from "../packages/core/src/repositories/approval.repo";
import { logApprovalDecision } from "../packages/core/src/lib/approval-audit";
import { expirePendingApprovals } from "../packages/agent/src/scheduler/approval-sweeper";
import {
  sendApprovalPrompt,
  registerApprovalCallbacks,
} from "../packages/agent/src/telegram/bot/approvals";
import type { Bot } from "grammy";

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

function getMetricsRows(db: Database): Array<{ id: number; timestamp: number; snapshot: string }> {
  return db.query("SELECT * FROM metrics_log ORDER BY id").all() as Array<{
    id: number;
    timestamp: number;
    snapshot: string;
  }>;
}

function mockBot(): { bot: Bot; sent: Array<{ chatId: number; text: string; opts: unknown }> } {
  const sent: Array<{ chatId: number; text: string; opts: unknown }> = [];
  const bot = {
    api: {
      sendMessage: (chatId: number, text: string, opts?: unknown) => {
        sent.push({ chatId, text, opts: opts ?? {} });
        return Promise.resolve({ message_id: 1 });
      },
    },
    on: (_event: string, _handler: unknown) => {
      // no-op for test
    },
  } as unknown as Bot;
  return { bot, sent };
}

describe("approval audit log", () => {
  let db: Database;
  let table: ApprovalsTable;
  let repo: ApprovalRepository;

  beforeEach(() => {
    db = createTestDb();
    table = new ApprovalsTable(db);
    repo = new ApprovalRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  test("logApprovalDecision inserts correct snapshot", () => {
    logApprovalDecision(db, {
      approvalId: "a1",
      toolName: "tg_send_message",
      status: "pending",
      requestedAt: 1000,
      resolvedAt: null,
    });

    const rows = getMetricsRows(db);
    expect(rows.length).toBe(1);
    const snap = JSON.parse(rows[0].snapshot);
    expect(snap.kind).toBe("approval_decision");
    expect(snap.approval_id).toBe("a1");
    expect(snap.tool_name).toBe("tg_send_message");
    expect(snap.status).toBe("pending");
    expect(snap.requested_at).toBe(1000);
    expect(snap.resolved_at).toBeNull();
    expect(rows[0].timestamp).toBeGreaterThan(0);
  });

  test("approval-gate plugin logs on pending insert", () => {
    const id = table.insert({
      tool_name: "tg_send_message",
      args_hash: "abc",
      status: "pending",
      requested_at: 1234,
      resolved_at: null,
      operator_chat_id: 1,
      request_message: "test",
    });

    logApprovalDecision(db, {
      approvalId: id,
      toolName: "tg_send_message",
      status: "pending",
      requestedAt: 1234,
      resolvedAt: null,
    });

    const rows = getMetricsRows(db);
    expect(rows.length).toBe(1);
    const snap = JSON.parse(rows[0].snapshot);
    expect(snap.status).toBe("pending");
    expect(snap.approval_id).toBe(id);
  });

  test("bot callback logs on approve", async () => {
    const id = repo.create({
      tool_name: "tg_send_message",
      args_hash: "h1",
      status: "pending",
      requested_at: 1,
      resolved_at: null,
      operator_chat_id: 123,
      request_message: "r1",
    });

    const ctx = {
      callbackQuery: { data: `approve:${id}` },
      answerCallbackQuery: async (_opts: { text: string }) => {},
      editMessageText: async (_text: string, _opts?: unknown) => {},
    };

    let capturedHandler: ((ctx: typeof ctx) => Promise<void>) | null = null;
    const mockBot2 = {
      on: (_event: string, handler: unknown) => {
        capturedHandler = handler as (ctx: typeof ctx) => Promise<void>;
      },
    } as unknown as Bot;

    registerApprovalCallbacks(mockBot2, { approvalRepo: repo, db });
    expect(capturedHandler).not.toBeNull();
    await capturedHandler!(ctx);

    const rows = getMetricsRows(db);
    expect(rows.length).toBe(1);
    const snap = JSON.parse(rows[0].snapshot);
    expect(snap.kind).toBe("approval_decision");
    expect(snap.status).toBe("approved");
    expect(snap.approval_id).toBe(id);
    expect(snap.resolved_at).not.toBeNull();
  });

  test("bot callback logs on deny", async () => {
    const id = repo.create({
      tool_name: "tg_send_report",
      args_hash: "h2",
      status: "pending",
      requested_at: 2,
      resolved_at: null,
      operator_chat_id: 123,
      request_message: "r2",
    });

    const ctx = {
      callbackQuery: { data: `deny:${id}` },
      answerCallbackQuery: async (_opts: { text: string }) => {},
      editMessageText: async (_text: string, _opts?: unknown) => {},
    };

    let capturedHandler: ((ctx: typeof ctx) => Promise<void>) | null = null;
    const mockBot2 = {
      on: (_event: string, handler: unknown) => {
        capturedHandler = handler as (ctx: typeof ctx) => Promise<void>;
      },
    } as unknown as Bot;

    registerApprovalCallbacks(mockBot2, { approvalRepo: repo, db });
    await capturedHandler!(ctx);

    const rows = getMetricsRows(db);
    expect(rows.length).toBe(1);
    const snap = JSON.parse(rows[0].snapshot);
    expect(snap.status).toBe("denied");
    expect(snap.approval_id).toBe(id);
  });

  test("sweeper logs on expiry", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const id = table.insert({
      tool_name: "tg_send_message",
      args_hash: "old",
      status: "pending",
      requested_at: nowSec - 1000,
      resolved_at: null,
      operator_chat_id: 1,
      request_message: "old request",
    });

    const count = expirePendingApprovals(db, 100);
    expect(count).toBe(1);

    const rows = getMetricsRows(db);
    expect(rows.length).toBe(1);
    const snap = JSON.parse(rows[0].snapshot);
    expect(snap.kind).toBe("approval_decision");
    expect(snap.status).toBe("expired");
    expect(snap.approval_id).toBe(id);
    expect(snap.resolved_at).not.toBeNull();
  });

  test("sweeper does not log when nothing expires", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    table.insert({
      tool_name: "tg_send_message",
      args_hash: "fresh",
      status: "pending",
      requested_at: nowSec,
      resolved_at: null,
      operator_chat_id: 1,
      request_message: "fresh request",
    });

    const count = expirePendingApprovals(db, 1000);
    expect(count).toBe(0);

    const rows = getMetricsRows(db);
    expect(rows.length).toBe(0);
  });
});
