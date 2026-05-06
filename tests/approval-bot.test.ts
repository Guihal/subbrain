import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../packages/core/src/db/schema";
import { ApprovalsTable } from "../packages/core/src/db/tables/approvals";
import { ApprovalRepository } from "../packages/core/src/repositories/approval.repo";
import { sendApprovalPrompt, registerApprovalCallbacks } from "../packages/agent/src/telegram/bot/approvals";
import type { Bot } from "grammy";

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
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

describe("approval bot surface", () => {
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

  test("sendApprovalPrompt sends inline keyboard", () => {
    const { bot, sent } = mockBot();
    const row = table.insert({
      tool_name: "tg_send_message",
      args_hash: "abc",
      status: "pending",
      requested_at: 1,
      resolved_at: null,
      operator_chat_id: 123,
      request_message: "test msg",
    });
    const found = table.getById(row);
    expect(found).not.toBeNull();
    sendApprovalPrompt(bot, 123, found!);

    expect(sent.length).toBe(1);
    expect(sent[0].chatId).toBe(123);
    expect(sent[0].text).toContain("tg\\_send\\_message");
    const opts = sent[0].opts as {
      parse_mode: string;
      reply_markup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
    };
    expect(opts.parse_mode).toBe("MarkdownV2");
    expect(opts.reply_markup.inline_keyboard[0][0].text).toBe("✅ Approve");
    expect(opts.reply_markup.inline_keyboard[0][0].callback_data).toBe(`approve:${row}`);
    expect(opts.reply_markup.inline_keyboard[0][1].text).toBe("❌ Deny");
    expect(opts.reply_markup.inline_keyboard[0][1].callback_data).toBe(`deny:${row}`);
  });

  test("callback handler approves pending row", async () => {
    const id = repo.create({
      tool_name: "tg_send_message",
      args_hash: "h1",
      status: "pending",
      requested_at: 1,
      resolved_at: null,
      operator_chat_id: 123,
      request_message: "r1",
    });

    const answers: string[] = [];
    const edits: string[] = [];
    const ctx = {
      callbackQuery: { data: `approve:${id}` },
      answerCallbackQuery: async ({ text }: { text: string }) => {
        answers.push(text);
      },
      editMessageText: async (text: string, _opts?: unknown) => {
        edits.push(text);
      },
    };

    // Simulate the handler directly by calling the middleware function
    // Since registerApprovalCallbacks uses bot.on, we test the handler logic
    // by extracting it through a mock bot that captures the handler.
    let capturedHandler: ((ctx: typeof ctx) => Promise<void>) | null = null;
    const mockBot2 = {
      on: (_event: string, handler: unknown) => {
        capturedHandler = handler as (ctx: typeof ctx) => Promise<void>;
      },
    } as unknown as Bot;

    registerApprovalCallbacks(mockBot2, { approvalRepo: repo });
    expect(capturedHandler).not.toBeNull();
    await capturedHandler!(ctx);

    const found = repo.getById(id);
    expect(found!.status).toBe("approved");
    expect(answers).toContain("Approved");
    expect(edits.length).toBe(1);
    expect(edits[0]).toContain("APPROVED");
  });

  test("callback handler denies pending row", async () => {
    const id = repo.create({
      tool_name: "tg_send_report",
      args_hash: "h2",
      status: "pending",
      requested_at: 1,
      resolved_at: null,
      operator_chat_id: 123,
      request_message: "r2",
    });

    const answers: string[] = [];
    const edits: string[] = [];
    const ctx = {
      callbackQuery: { data: `deny:${id}` },
      answerCallbackQuery: async ({ text }: { text: string }) => {
        answers.push(text);
      },
      editMessageText: async (text: string, _opts?: unknown) => {
        edits.push(text);
      },
    };

    let capturedHandler: ((ctx: typeof ctx) => Promise<void>) | null = null;
    const mockBot2 = {
      on: (_event: string, handler: unknown) => {
        capturedHandler = handler as (ctx: typeof ctx) => Promise<void>;
      },
    } as unknown as Bot;

    registerApprovalCallbacks(mockBot2, { approvalRepo: repo });
    await capturedHandler!(ctx);

    const found = repo.getById(id);
    expect(found!.status).toBe("denied");
    expect(answers).toContain("Denied");
    expect(edits[0]).toContain("DENIED");
  });

  test("callback handler ignores non-approval callbacks", async () => {
    let capturedHandler: ((ctx: { callbackQuery: { data: string } }) => Promise<void>) | null = null;
    const mockBot2 = {
      on: (_event: string, handler: unknown) => {
        capturedHandler = handler as (ctx: { callbackQuery: { data: string } }) => Promise<void>;
      },
    } as unknown as Bot;

    registerApprovalCallbacks(mockBot2, { approvalRepo: repo });

    const ctx = { callbackQuery: { data: "other:data" } };
    // Should not throw
    await capturedHandler!(ctx);
  });

  test("double-click protection — second update returns 0 changes", async () => {
    const id = repo.create({
      tool_name: "tg_send_message",
      args_hash: "h3",
      status: "pending",
      requested_at: 1,
      resolved_at: null,
      operator_chat_id: 123,
      request_message: "r3",
    });

    const answers: string[] = [];
    const ctx = {
      callbackQuery: { data: `approve:${id}` },
      answerCallbackQuery: async ({ text }: { text: string }) => {
        answers.push(text);
      },
      editMessageText: async (_text: string, _opts?: unknown) => {},
    };

    let capturedHandler: ((ctx: typeof ctx) => Promise<void>) | null = null;
    const mockBot2 = {
      on: (_event: string, handler: unknown) => {
        capturedHandler = handler as (ctx: typeof ctx) => Promise<void>;
      },
    } as unknown as Bot;

    registerApprovalCallbacks(mockBot2, { approvalRepo: repo });
    await capturedHandler!(ctx);

    // Second click
    const answers2: string[] = [];
    const ctx2 = {
      callbackQuery: { data: `approve:${id}` },
      answerCallbackQuery: async ({ text }: { text: string }) => {
        answers2.push(text);
      },
      editMessageText: async (_text: string, _opts?: unknown) => {},
    };
    await capturedHandler!(ctx2);

    expect(answers2).toContain("Already resolved or not found");
  });

  test("callback handler answers 'not found' for missing row", async () => {
    const answers: string[] = [];
    const ctx = {
      callbackQuery: { data: "approve:nonexistent-id" },
      answerCallbackQuery: async ({ text }: { text: string }) => {
        answers.push(text);
      },
      editMessageText: async (_text: string, _opts?: unknown) => {},
    };

    let capturedHandler: ((ctx: typeof ctx) => Promise<void>) | null = null;
    const mockBot2 = {
      on: (_event: string, handler: unknown) => {
        capturedHandler = handler as (ctx: typeof ctx) => Promise<void>;
      },
    } as unknown as Bot;

    registerApprovalCallbacks(mockBot2, { approvalRepo: repo });
    await capturedHandler!(ctx);

    expect(answers).toContain("Already resolved or not found");
  });
});
