/**
 * 8a-3 integration test: approval-gate plugin.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { approvalGatePlugin } from "@subbrain/agent/plugins-internal/approval-gate";
import { MemoryDB } from "@subbrain/core/db";
import { ApprovalsTable } from "@subbrain/core/db/tables/approvals";
import { toLegacy } from "@subbrain/plugin";

function makeHooks() {
  const before: any[] = [];
  approvalGatePlugin.setup({
    hooks: {
      onToolBefore(h) {
        before.push(h);
      },
      onToolAfter() {},
      onChatParams() {},
      onChatSystemTransform() {},
      onPermissionAsk() {},
    },
  });
  return { before };
}

function makeCtx(memoryDb?: MemoryDB) {
  return {
    agentMode: "interactive" as const,
    executor: memoryDb ? ({ memoryDb } as any) : undefined,
  };
}

describe("approval-gate plugin", () => {
  let db: MemoryDB;

  beforeEach(() => {
    db = new MemoryDB(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  test("registers one onToolBefore handler", () => {
    const { before } = makeHooks();
    expect(before.length).toBe(1);
  });

  test("passthrough for non-gated tool", async () => {
    const { before } = makeHooks();
    const handler = before[0];
    const result = await handler({
      toolName: "memory_search",
      args: { q: "test" },
      ctx: makeCtx(db),
    });
    expect(result).toBeUndefined();
  });

  test("approval_unavailable when resolveOperatorChat returns null", async () => {
    const { before } = makeHooks();
    const handler = before[0];
    const prev = process.env.APPROVAL_OPERATOR_CHAT_ID;
    const prev2 = process.env.TG_OWNER_CHAT_ID;
    (process.env as any).APPROVAL_OPERATOR_CHAT_ID = undefined;
    (process.env as any).TG_OWNER_CHAT_ID = undefined;

    try {
      const result = await handler({
        toolName: "tg_send_message",
        args: { text: "hello" },
        ctx: makeCtx(db),
      });
      expect(result).toBeDefined();
      expect(result?.kind).toBe("denied");
      expect(result?.error.code).toBe("approval_unavailable");
      const legacy = toLegacy(result!);
      expect(legacy.success).toBe(false);
    } finally {
      if (prev !== undefined) process.env.APPROVAL_OPERATOR_CHAT_ID = prev;
      if (prev2 !== undefined) process.env.TG_OWNER_CHAT_ID = prev2;
    }
  });

  test("awaiting_approval for gated tool with no existing row", async () => {
    const { before } = makeHooks();
    const handler = before[0];
    process.env.APPROVAL_OPERATOR_CHAT_ID = "12345";

    const result = await handler({
      toolName: "tg_send_message",
      args: { text: "hello" },
      ctx: makeCtx(db),
    });
    expect(result).toBeDefined();
    expect(result?.kind).toBe("denied");
    expect(result?.error.code).toBe("awaiting_approval");

    // Verify pending row inserted
    const table = new ApprovalsTable(db.db);
    const rows = table.listPending(10);
    expect(rows.length).toBe(1);
    expect(rows[0].tool_name).toBe("tg_send_message");
    expect(rows[0].status).toBe("pending");
  });

  test("passthrough when approved row exists and is fresh", async () => {
    const { before } = makeHooks();
    const handler = before[0];
    process.env.APPROVAL_OPERATOR_CHAT_ID = "12345";

    const table = new ApprovalsTable(db.db);
    const argsHash = '{"text":"hello"}';
    const nowSec = Math.floor(Date.now() / 1000);
    table.insert({
      tool_name: "tg_send_message",
      args_hash: argsHash,
      status: "approved",
      requested_at: nowSec,
      resolved_at: nowSec,
      operator_chat_id: 12345,
      request_message: "test",
    });

    const result = await handler({
      toolName: "tg_send_message",
      args: { text: "hello" },
      ctx: makeCtx(db),
    });
    expect(result).toBeUndefined();
  });

  test("approval_denied when denied row exists", async () => {
    const { before } = makeHooks();
    const handler = before[0];
    process.env.APPROVAL_OPERATOR_CHAT_ID = "12345";

    const table = new ApprovalsTable(db.db);
    const argsHash = '{"text":"hello"}';
    const nowSec = Math.floor(Date.now() / 1000);
    table.insert({
      tool_name: "tg_send_message",
      args_hash: argsHash,
      status: "denied",
      requested_at: nowSec,
      resolved_at: nowSec,
      operator_chat_id: 12345,
      request_message: "test",
    });

    const result = await handler({
      toolName: "tg_send_message",
      args: { text: "hello" },
      ctx: makeCtx(db),
    });
    expect(result).toBeDefined();
    expect(result?.kind).toBe("denied");
    expect(result?.error.code).toBe("approval_denied");
  });

  test("awaiting_approval when pending row exists", async () => {
    const { before } = makeHooks();
    const handler = before[0];
    process.env.APPROVAL_OPERATOR_CHAT_ID = "12345";

    const table = new ApprovalsTable(db.db);
    const argsHash = '{"text":"hello"}';
    const nowSec = Math.floor(Date.now() / 1000);
    table.insert({
      tool_name: "tg_send_message",
      args_hash: argsHash,
      status: "pending",
      requested_at: nowSec,
      resolved_at: null,
      operator_chat_id: 12345,
      request_message: "test",
    });

    const result = await handler({
      toolName: "tg_send_message",
      args: { text: "hello" },
      ctx: makeCtx(db),
    });
    expect(result).toBeDefined();
    expect(result?.kind).toBe("denied");
    expect(result?.error.code).toBe("awaiting_approval");
  });

  test("stale approved row is treated as none → insert pending", async () => {
    const { before } = makeHooks();
    const handler = before[0];
    process.env.APPROVAL_OPERATOR_CHAT_ID = "12345";

    const table = new ApprovalsTable(db.db);
    const argsHash = '{"text":"hello"}';
    const nowSec = Math.floor(Date.now() / 1000);
    table.insert({
      tool_name: "tg_send_message",
      args_hash: argsHash,
      status: "approved",
      requested_at: nowSec - 2000,
      resolved_at: nowSec - 2000,
      operator_chat_id: 12345,
      request_message: "test",
    });

    const result = await handler({
      toolName: "tg_send_message",
      args: { text: "hello" },
      ctx: makeCtx(db),
    });
    expect(result).toBeDefined();
    expect(result?.kind).toBe("denied");
    expect(result?.error.code).toBe("awaiting_approval");
  });

  test("scheduled mode also gates tg_send_message", async () => {
    const { before } = makeHooks();
    const handler = before[0];
    process.env.APPROVAL_OPERATOR_CHAT_ID = "12345";

    const result = await handler({
      toolName: "tg_send_message",
      args: { text: "hello" },
      ctx: { agentMode: "scheduled", executor: { memoryDb: db } as any },
    });
    expect(result).toBeDefined();
    expect(result?.kind).toBe("denied");
    expect(result?.error.code).toBe("awaiting_approval");
  });
});
