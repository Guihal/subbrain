import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { MemoryDB } from "@subbrain/core/db";
import type { ModelRouter } from "../src/lib/model-router";
import {
  applyCommand,
  buildRemindPrompt,
  collectRemindCandidates,
  emptyState,
  parseCommand,
  type TaskState,
} from "../src/scheduler/telegram-commands";
import {
  LAST_ID_FOCUS_KEY,
  TASK_STATE_FOCUS_KEY,
  TelegramPoller,
  type TelegramPollerDeps,
  type TgInboxMessage,
} from "../src/scheduler/telegram-poller";

const TEST_DB = "data/test-telegram-poller.db";

function freshDb(): MemoryDB {
  try {
    unlinkSync(TEST_DB);
  } catch {}
  return new MemoryDB(TEST_DB);
}

describe("parseCommand", () => {
  test("+task work", () => {
    expect(parseCommand("+task work починить billing")).toEqual({
      kind: "add",
      list: "work",
      text: "починить billing",
    });
  });
  test("+task home with due", () => {
    const cmd = parseCommand("+task home оплатить интернет !2030-01-01 12:00");
    expect(cmd.kind).toBe("add");
    if (cmd.kind === "add") {
      expect(cmd.list).toBe("home");
      expect(cmd.text).toBe("оплатить интернет");
      expect(cmd.due).toBeGreaterThan(1_800_000_000);
    }
  });
  test("done w3", () => {
    expect(parseCommand("done w3")).toEqual({ kind: "done", id: "w3" });
  });
  test("list work", () => {
    expect(parseCommand("list work")).toEqual({ kind: "list", list: "work" });
  });
  test("garbage → unknown", () => {
    expect(parseCommand("hello there").kind).toBe("unknown");
  });
});

describe("applyCommand", () => {
  test("add assigns sequential ids per list", () => {
    let s: TaskState = emptyState();
    s = applyCommand(s, { kind: "add", list: "work", text: "a" }, 100).state;
    s = applyCommand(s, { kind: "add", list: "work", text: "b" }, 101).state;
    s = applyCommand(s, { kind: "add", list: "home", text: "c" }, 102).state;
    expect(s["tasks.work"].map((t) => t.id)).toEqual(["w1", "w2"]);
    expect(s["tasks.home"].map((t) => t.id)).toEqual(["h1"]);
  });

  test("done non-existent leaves state untouched, does not throw", () => {
    const s0 = applyCommand(emptyState(), { kind: "add", list: "work", text: "a" }, 100).state;
    const r = applyCommand(s0, { kind: "done", id: "w9" }, 200);
    expect(r.state["tasks.work"].length).toBe(1);
    expect(r.receipt).toContain("не найдена");
  });

  test("done removes task", () => {
    let s = applyCommand(emptyState(), { kind: "add", list: "work", text: "a" }, 100).state;
    s = applyCommand(s, { kind: "done", id: "w1" }, 101).state;
    expect(s["tasks.work"].length).toBe(0);
  });
});

describe("collectRemindCandidates", () => {
  const now = 1_800_000_000;
  const stale = 6 * 3600;

  test("overdue due + stale no-due, ignores fresh", () => {
    const state: TaskState = {
      "tasks.work": [
        { id: "w1", text: "overdue", created_at: now - 10, due: now - 100 },
        { id: "w2", text: "fresh", created_at: now - 60 },
      ],
      "tasks.home": [{ id: "h1", text: "stale", created_at: now - 7 * 3600 }],
    };
    const got = collectRemindCandidates(state, now, stale);
    expect(got.map((c) => c.task.id)).toEqual(["h1", "w1"]);
  });

  test("empty → empty", () => {
    expect(collectRemindCandidates(emptyState(), now, stale)).toEqual([]);
  });
});

describe("buildRemindPrompt", () => {
  test("mentions counts + overdue + candidates", () => {
    const state: TaskState = {
      "tasks.work": [
        { id: "w1", text: "X", created_at: 1, due: 2 },
        { id: "w2", text: "Y", created_at: 1 },
      ],
      "tasks.home": [],
    };
    const cands = collectRemindCandidates(state, 100, 1);
    const prompt = buildRemindPrompt(cands, state);
    expect(prompt).toContain("work=2");
    expect(prompt).toContain("home=0");
    expect(prompt).toContain("w1");
  });
});

// ─── Poller integration (mock reader + router) ─────────────────

interface MockState {
  inbox: TgInboxMessage[];
  sent: string[];
  routerCalls: number;
  routerReply: string;
}

function buildPoller(mock: MockState, memory: MemoryDB): TelegramPoller {
  const fakeRouter = {
    chat: async () => {
      mock.routerCalls++;
      return {
        id: "x",
        object: "chat.completion" as const,
        created: 0,
        model: "flash",
        choices: [
          {
            index: 0,
            message: { role: "assistant" as const, content: mock.routerReply },
            finish_reason: "stop",
          },
        ],
      };
    },
  };
  const deps: TelegramPollerDeps = {
    memory,
    router: fakeRouter as unknown as ModelRouter,
    readInbox: async () => mock.inbox,
    sendNotify: async (text) => {
      mock.sent.push(text);
    },
    config: {
      remindChatId: "owner",
      pollIntervalMs: 600_000,
      remindIntervalMs: 1_800_000,
      staleHours: 6,
      remindModel: "flash",
    },
  };
  return new TelegramPoller(deps);
}

describe("TelegramPoller", () => {
  let memory: MemoryDB;

  beforeEach(() => {
    memory = freshDb();
  });
  afterEach(() => {
    memory.close();
    try {
      unlinkSync(TEST_DB);
    } catch {}
  });

  test("poll processes new commands, writes state, sends receipts", async () => {
    const mock: MockState = {
      inbox: [
        { id: 1, text: "+task work fix bug", date: "", sender: "me" },
        { id: 2, text: "+task home buy milk", date: "", sender: "me" },
        { id: 3, text: "done w1", date: "", sender: "me" },
        { id: 4, text: "random noise", date: "", sender: "me" },
      ],
      sent: [],
      routerCalls: 0,
      routerReply: "",
    };
    const poller = buildPoller(mock, memory);
    await poller.tickPoll();

    const raw = memory.getFocus(TASK_STATE_FOCUS_KEY);
    expect(raw).toBeTruthy();
    const state = JSON.parse(raw!) as TaskState;
    expect(state["tasks.work"].length).toBe(0);
    expect(state["tasks.home"].map((t) => t.id)).toEqual(["h1"]);
    expect(memory.getFocus(LAST_ID_FOCUS_KEY)).toBe("4");
    // 3 receipts (add w1, add h1, done w1). Unknown is ignored.
    expect(mock.sent.length).toBe(3);
  });

  test("poll second run with same inbox does nothing (lastId guard)", async () => {
    const mock: MockState = {
      inbox: [{ id: 10, text: "+task work foo", date: "", sender: "me" }],
      sent: [],
      routerCalls: 0,
      routerReply: "",
    };
    const poller = buildPoller(mock, memory);
    await poller.tickPoll();
    expect(mock.sent.length).toBe(1);
    await poller.tickPoll();
    expect(mock.sent.length).toBe(1);
  });

  test("remind: no candidates → no model, no send", async () => {
    const mock: MockState = {
      inbox: [],
      sent: [],
      routerCalls: 0,
      routerReply: "🔔 …",
    };
    const poller = buildPoller(mock, memory);
    await poller.tickRemind();
    expect(mock.routerCalls).toBe(0);
    expect(mock.sent.length).toBe(0);
  });

  test("remind: stale task → model called, message sent", async () => {
    const now = Math.floor(Date.now() / 1000);
    const state: TaskState = {
      "tasks.work": [{ id: "w1", text: "old", created_at: now - 7 * 3600 }],
      "tasks.home": [],
    };
    memory.setFocus(TASK_STATE_FOCUS_KEY, JSON.stringify(state));

    const mock: MockState = {
      inbox: [],
      sent: [],
      routerCalls: 0,
      routerReply: "🔔 Work: 1 задача (0 просрочены)",
    };
    const poller = buildPoller(mock, memory);
    await poller.tickRemind();
    expect(mock.routerCalls).toBe(1);
    expect(mock.sent.length).toBe(1);
    expect(mock.sent[0]).toContain("🔔");
  });

  test("guard: concurrent tickPoll skipped", async () => {
    let resolveRead: (() => void) | null = null;
    const mock: MockState = {
      inbox: [],
      sent: [],
      routerCalls: 0,
      routerReply: "",
    };
    const memory2 = memory;
    const poller = new TelegramPoller({
      memory: memory2,
      router: { chat: async () => ({}) } as unknown as ModelRouter,
      readInbox: () =>
        new Promise((resolve) => {
          resolveRead = () => resolve([]);
        }),
      sendNotify: async () => {},
      config: {
        remindChatId: "owner",
        pollIntervalMs: 1,
        remindIntervalMs: 1,
        staleHours: 6,
        remindModel: "flash",
      },
    });
    const first = poller.tickPoll();
    const second = poller.tickPoll(); // should early-return
    resolveRead?.();
    await Promise.all([first, second]);
    expect(mock.sent.length).toBe(0);
  });
});
