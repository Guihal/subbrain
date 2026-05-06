import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { migrate } from "../packages/core/src/db/schema";
import { ApprovalsTable } from "../packages/core/src/db/tables/approvals";
import { ApprovalRepository } from "../packages/core/src/repositories/approval.repo";

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

describe("approvals schema", () => {
  let db: Database;
  let _table: ApprovalsTable;
  let repo: ApprovalRepository;

  beforeEach(() => {
    db = createTestDb();
    _table = new ApprovalsTable(db);
    repo = new ApprovalRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  test("migration 21 creates approvals table", () => {
    const row = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'approvals'")
      .get() as { name: string } | null;
    expect(row?.name).toBe("approvals");
  });

  test("create + retrieve round-trip", () => {
    const id = repo.create({
      tool_name: "tg_send_message",
      args_hash: "abc123",
      status: "pending",
      requested_at: Math.floor(Date.now() / 1000),
      resolved_at: null,
      operator_chat_id: 123456,
      request_message: "Send message to chat 42",
    });

    expect(id).toBeString();
    const found = repo.getById(id);
    expect(found).not.toBeNull();
    expect(found?.tool_name).toBe("tg_send_message");
    expect(found?.args_hash).toBe("abc123");
    expect(found?.status).toBe("pending");
    expect(found?.operator_chat_id).toBe(123456);
  });

  test("getByToolAndHash returns latest row", () => {
    const now = Math.floor(Date.now() / 1000);
    repo.create({
      tool_name: "tg_send_message",
      args_hash: "hashA",
      status: "pending",
      requested_at: now - 10,
      resolved_at: null,
      operator_chat_id: 1,
      request_message: "first",
    });
    repo.create({
      tool_name: "tg_send_message",
      args_hash: "hashA",
      status: "approved",
      requested_at: now,
      resolved_at: null,
      operator_chat_id: 1,
      request_message: "second",
    });

    const found = repo.getByToolAndHash("tg_send_message", "hashA");
    expect(found).not.toBeNull();
    expect(found?.status).toBe("approved");
    expect(found?.request_message).toBe("second");
  });

  test("unique constraint on (tool_name, args_hash) for pending", () => {
    const now = Math.floor(Date.now() / 1000);
    repo.create({
      tool_name: "tg_send_message",
      args_hash: "dup",
      status: "pending",
      requested_at: now,
      resolved_at: null,
      operator_chat_id: 1,
      request_message: "first",
    });

    expect(() =>
      repo.create({
        tool_name: "tg_send_message",
        args_hash: "dup",
        status: "pending",
        requested_at: now,
        resolved_at: null,
        operator_chat_id: 1,
        request_message: "second",
      }),
    ).toThrow();
  });

  test("unique constraint allows denied + fresh pending", () => {
    const now = Math.floor(Date.now() / 1000);
    const id1 = repo.create({
      tool_name: "tg_send_message",
      args_hash: "x",
      status: "pending",
      requested_at: now,
      resolved_at: null,
      operator_chat_id: 1,
      request_message: "first",
    });
    repo.updateStatus(id1, "denied", now + 1);

    const id2 = repo.create({
      tool_name: "tg_send_message",
      args_hash: "x",
      status: "pending",
      requested_at: now + 2,
      resolved_at: null,
      operator_chat_id: 1,
      request_message: "second",
    });
    expect(id2).toBeString();
    expect(id2).not.toBe(id1);
  });

  test("status transitions via updateStatus", () => {
    const now = Math.floor(Date.now() / 1000);
    const id = repo.create({
      tool_name: "tg_send_report",
      args_hash: "h",
      status: "pending",
      requested_at: now,
      resolved_at: null,
      operator_chat_id: 1,
      request_message: "r",
    });

    const changed = repo.updateStatus(id, "approved", now + 5);
    expect(changed).toBe(1);

    const found = repo.getById(id);
    expect(found?.status).toBe("approved");
    expect(found?.resolved_at).toBe(now + 5);
  });

  test("updateStatus is idempotent (resolved_at not null guard)", () => {
    const now = Math.floor(Date.now() / 1000);
    const id = repo.create({
      tool_name: "tg_send_report",
      args_hash: "h",
      status: "pending",
      requested_at: now,
      resolved_at: null,
      operator_chat_id: 1,
      request_message: "r",
    });

    repo.updateStatus(id, "approved", now + 5);
    const changed = repo.updateStatus(id, "denied", now + 10);
    expect(changed).toBe(0);

    const found = repo.getById(id);
    expect(found?.status).toBe("approved");
  });

  test("listPending returns only pending rows", () => {
    const now = Math.floor(Date.now() / 1000);
    repo.create({
      tool_name: "a",
      args_hash: "h1",
      status: "pending",
      requested_at: now,
      resolved_at: null,
      operator_chat_id: 1,
      request_message: "p1",
    });
    const id2 = repo.create({
      tool_name: "b",
      args_hash: "h2",
      status: "pending",
      requested_at: now + 1,
      resolved_at: null,
      operator_chat_id: 1,
      request_message: "p2",
    });
    repo.updateStatus(id2, "approved", now + 2);

    const pending = repo.listPending(10);
    expect(pending.length).toBe(1);
    expect(pending[0].tool_name).toBe("a");
  });

  test("migration idempotency — re-run does not throw", () => {
    // migrate() already ran in createTestDb; run again.
    expect(() => migrate(db)).not.toThrow();

    const row = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'approvals'")
      .get() as { name: string } | null;
    expect(row?.name).toBe("approvals");
  });
});
