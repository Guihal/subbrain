import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../packages/core/src/db/schema";
import { ApprovalsTable } from "../packages/core/src/db/tables/approvals";
import { expirePendingApprovals, ApprovalSweeper } from "../packages/agent/src/scheduler/approval-sweeper";

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

describe("expirePendingApprovals", () => {
  let db: Database;
  let table: ApprovalsTable;

  beforeEach(() => {
    db = createTestDb();
    table = new ApprovalsTable(db);
  });

  afterEach(() => {
    db.close();
  });

  test("pending row within TTL is not expired", () => {
    const now = Math.floor(Date.now() / 1000);
    table.insert({
      tool_name: "tg_send_message",
      args_hash: "h1",
      status: "pending",
      requested_at: now - 100,
      resolved_at: null,
      operator_chat_id: 1,
      request_message: "r1",
    });

    const changed = expirePendingApprovals(db, 900);
    expect(changed).toBe(0);

    const rows = table.listPending(10);
    expect(rows.length).toBe(1);
  });

  test("pending row past TTL is expired", () => {
    const now = Math.floor(Date.now() / 1000);
    const id = table.insert({
      tool_name: "tg_send_message",
      args_hash: "h2",
      status: "pending",
      requested_at: now - 1000,
      resolved_at: null,
      operator_chat_id: 1,
      request_message: "r2",
    });

    const changed = expirePendingApprovals(db, 900);
    expect(changed).toBe(1);

    const row = table.getById(id);
    expect(row).not.toBeNull();
    expect(row!.status).toBe("expired");
    expect(row!.resolved_at).not.toBeNull();
  });

  test("approved/denied rows are not touched", () => {
    const now = Math.floor(Date.now() / 1000);
    table.insert({
      tool_name: "tg_send_message",
      args_hash: "ha",
      status: "approved",
      requested_at: now - 2000,
      resolved_at: now - 1000,
      operator_chat_id: 1,
      request_message: "ra",
    });
    table.insert({
      tool_name: "tg_send_message",
      args_hash: "hd",
      status: "denied",
      requested_at: now - 2000,
      resolved_at: now - 1000,
      operator_chat_id: 1,
      request_message: "rd",
    });

    const changed = expirePendingApprovals(db, 900);
    expect(changed).toBe(0);
  });

  test("idempotency: second sweep on already expired row changes nothing", () => {
    const now = Math.floor(Date.now() / 1000);
    table.insert({
      tool_name: "tg_send_message",
      args_hash: "h3",
      status: "pending",
      requested_at: now - 2000,
      resolved_at: null,
      operator_chat_id: 1,
      request_message: "r3",
    });

    const c1 = expirePendingApprovals(db, 900);
    expect(c1).toBe(1);

    const c2 = expirePendingApprovals(db, 900);
    expect(c2).toBe(0);
  });
});

describe("ApprovalSweeper", () => {
  let db: Database;
  let sweeper: ApprovalSweeper;

  beforeEach(() => {
    db = createTestDb();
    sweeper = new ApprovalSweeper({ db, ttlSec: 1 });
  });

  afterEach(() => {
    sweeper.stop();
    db.close();
  });

  test("start/stop does not throw", () => {
    sweeper.start();
    sweeper.stop();
  });

  test("tick expires stale pending rows", () => {
    const table = new ApprovalsTable(db);
    const now = Math.floor(Date.now() / 1000);
    table.insert({
      tool_name: "tg_send_message",
      args_hash: "h4",
      status: "pending",
      requested_at: now - 10,
      resolved_at: null,
      operator_chat_id: 1,
      request_message: "r4",
    });

    sweeper.start();
    // Allow one tick to fire (interval is fast in tests, but tick() runs immediately on start).
    const row = table.getByToolAndHash("tg_send_message", "h4");
    expect(row).not.toBeNull();
    expect(row!.status).toBe("expired");
  });
});
