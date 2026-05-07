/**
 * bug-5: assert that `TelegramPoller` and `userbot/monitor.attachMonitor`
 * have disjoint write surfaces, so they cannot produce duplicate raw_log
 * rows even when both target the same chat_id.
 *
 * Contract under test:
 *   - Poller.runPoll writes ONLY layer1_focus KV (`tasks.state`,
 *     `tg.poller.last_id`). It never calls `memory.appendLog` and emits no
 *     role="channel_message" rows.
 *   - Monitor writes layer4_log rows with role="channel_message" via
 *     `memory.appendLog`, keyed by a unique `tg-monitor-${Date.now()}`
 *     request_id. It never touches the poller's focus keys.
 *
 * Therefore: chat_id overlap is irrelevant — the two subsystems write to
 * non-overlapping spaces by construction.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import {
  LAST_ID_FOCUS_KEY,
  TASK_STATE_FOCUS_KEY,
  TelegramPoller,
  type TelegramPollerDeps,
  type TgInboxMessage,
} from "@subbrain/agent/scheduler/telegram-poller";
import { attachMonitor } from "@subbrain/agent/telegram/userbot/monitor";
import { MemoryDB } from "@subbrain/core/db";
import type { ModelRouter } from "@subbrain/core/lib/model-router";

const TEST_DB = "data/test-tg-poller-userbot-disjoint.db";
const SHARED_CHAT_ID = "1001234567890";

function freshDb(): MemoryDB {
  try {
    unlinkSync(TEST_DB);
  } catch {
    // ok: file may not exist
  }
  return new MemoryDB(TEST_DB);
}

function fakeRouter(): ModelRouter {
  return {
    chat: async () => ({
      id: "x",
      object: "chat.completion" as const,
      created: 0,
      model: "flash",
      choices: [
        {
          index: 0,
          message: { role: "assistant" as const, content: "" },
          finish_reason: "stop",
        },
      ],
    }),
  } as unknown as ModelRouter;
}

function buildPoller(memory: MemoryDB, inbox: TgInboxMessage[]): TelegramPoller {
  const deps: TelegramPollerDeps = {
    memory,
    router: fakeRouter(),
    readInbox: async () => inbox,
    sendNotify: async () => {
      // no-op for disjointness assertions
    },
    config: {
      remindChatId: SHARED_CHAT_ID,
      pollIntervalMs: 600_000,
      remindIntervalMs: 1_800_000,
      staleHours: 6,
      remindModel: "flash",
    },
  };
  return new TelegramPoller(deps);
}

/** Capture the handler registered via client.addEventHandler. */
interface FakeClient {
  addEventHandler: (h: (e: unknown) => Promise<void>) => void;
  getEntity: (peer: unknown) => Promise<{ username?: string }>;
}

function buildFakeClient(username: string): {
  client: FakeClient;
  invokeWith: (event: unknown) => Promise<void>;
} {
  let captured: ((e: unknown) => Promise<void>) | null = null;
  const client: FakeClient = {
    addEventHandler: (h) => {
      captured = h;
    },
    getEntity: async () => ({ username }),
  };
  return {
    client,
    invokeWith: async (event) => {
      if (!captured) throw new Error("monitor never registered handler");
      await captured(event);
    },
  };
}

function countChannelMessageRows(memory: MemoryDB): number {
  // biome-ignore lint/suspicious/noExplicitAny: bun:sqlite raw query for test
  const rows = (memory as unknown as { db: { query: (sql: string) => { all: () => any[] } } }).db
    .query("SELECT id FROM layer4_log WHERE role = 'channel_message'")
    .all();
  return rows.length;
}

describe("bug-5: poller × userbot.monitor write-surface disjointness", () => {
  let memory: MemoryDB;

  beforeEach(() => {
    memory = freshDb();
  });
  afterEach(() => {
    memory.close();
    try {
      unlinkSync(TEST_DB);
    } catch {
      // ok: cleanup race / already removed
    }
  });

  test("Poller.runPoll writes ONLY layer1_focus, no channel_message rows", async () => {
    const inbox: TgInboxMessage[] = [
      { id: 101, text: "+task work first", date: "2026-05-07T00:00:00Z", sender: "owner" },
      { id: 102, text: "+task home second", date: "2026-05-07T00:01:00Z", sender: "owner" },
    ];
    const poller = buildPoller(memory, inbox);

    expect(memory.getFocus(LAST_ID_FOCUS_KEY)).toBeNull();
    expect(memory.getFocus(TASK_STATE_FOCUS_KEY)).toBeNull();

    await poller.tickPoll();

    // Layer-1 focus advanced.
    expect(memory.getFocus(LAST_ID_FOCUS_KEY)).toBe("102");
    const state = memory.getFocus(TASK_STATE_FOCUS_KEY);
    expect(state).not.toBeNull();
    expect(state).toContain("first");

    // Layer-4 channel_message surface untouched by poller.
    expect(countChannelMessageRows(memory)).toBe(0);
  });

  test("Monitor writes exactly one channel_message row per allowlisted event", async () => {
    const username = "shared_chat";
    const { client, invokeWith } = buildFakeClient(username);
    attachMonitor(client as unknown as Parameters<typeof attachMonitor>[0], memory, [
      SHARED_CHAT_ID,
    ]);

    await invokeWith({
      message: {
        peerId: { channelId: { toString: () => SHARED_CHAT_ID } },
        message: "hello world",
      },
    });

    expect(countChannelMessageRows(memory)).toBe(1);
    // Poller's focus keys must remain untouched by monitor.
    expect(memory.getFocus(LAST_ID_FOCUS_KEY)).toBeNull();
    expect(memory.getFocus(TASK_STATE_FOCUS_KEY)).toBeNull();
  });

  test("Both subsystems on same chat_id → 0 duplicates (orthogonal surfaces)", async () => {
    const username = "shared_chat";
    const { client, invokeWith } = buildFakeClient(username);
    attachMonitor(client as unknown as Parameters<typeof attachMonitor>[0], memory, [
      SHARED_CHAT_ID,
    ]);

    // Same external message id (777) seen by both subsystems against the same chat_id.
    const inbox: TgInboxMessage[] = [
      { id: 777, text: "+task work shared", date: "2026-05-07T00:00:00Z", sender: "owner" },
    ];
    const poller = buildPoller(memory, inbox);

    // Realtime monitor sees the message first.
    await invokeWith({
      message: {
        peerId: { channelId: { toString: () => SHARED_CHAT_ID } },
        message: "shared payload",
      },
    });
    // Poller fetches the same chat afterwards (would be the duplicate scenario
    // bug-5 worried about). Run twice to model a missed-tick replay.
    await poller.tickPoll();
    await poller.tickPoll();

    // Monitor produced exactly one row; poller adds none.
    expect(countChannelMessageRows(memory)).toBe(1);
    // Poller advanced its own KV cursor; nothing leaked into channel_message.
    expect(memory.getFocus(LAST_ID_FOCUS_KEY)).toBe("777");
  });
});
