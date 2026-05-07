/**
 * Telegram poller — reads TG inbox every TG_POLL_INTERVAL_MIN minutes,
 * parses +task/done/list commands, updates layer1_focus, and sends
 * overdue-task reminders every TG_REMIND_INTERVAL_MIN minutes.
 *
 * Poller never calls pipeline models directly except for the small `flash`
 * summary in remind().
 *
 * Disjoint-by-design contract with `userbot/monitor.attachMonitor` (bug-5):
 * `runPoll` writes ONLY Layer-1 focus KV (`tasks.state`, `tg.poller.last_id`)
 * via `memory.setFocus`. It does NOT call `memory.appendLog` and emits no
 * role="channel_message" rows. Realtime monitor owns that surface. Even when
 * both subsystems target the same chat_id, their write surfaces are
 * orthogonal — no duplicate raw_log rows possible. See
 * `tests/tg-poller-userbot-disjoint.test.ts`.
 */
import type { MemoryDB } from "@subbrain/core/db";
import { logger } from "@subbrain/core/lib/logger";
import type { ModelRouter } from "@subbrain/core/lib/model-router";
import {
  applyCommand,
  buildRemindPrompt,
  collectRemindCandidates,
  emptyState,
  parseCommand,
  type TaskState,
} from "./telegram-commands";

const log = logger.child("tg-poller");

const TASK_STATE_KEY = "tasks.state";
const LAST_ID_KEY = "tg.poller.last_id";

export interface TgInboxMessage {
  id: number;
  text: string;
  date: string;
  sender: string;
}

export interface TelegramPollerDeps {
  memory: MemoryDB;
  router: ModelRouter;
  /** Reads inbox messages from TG_REMIND_CHAT_ID (newer first or older first). */
  readInbox: (chatId: string, limit: number) => Promise<TgInboxMessage[]>;
  /** Sends text back to user (bot notify or userbot send). */
  sendNotify: (text: string) => Promise<void>;
  config: {
    remindChatId: string;
    pollIntervalMs: number;
    remindIntervalMs: number;
    staleHours: number;
    remindModel: string;
  };
}

export class TelegramPoller {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private remindTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private reminding = false;

  constructor(private readonly deps: TelegramPollerDeps) {}

  isRunning(): boolean {
    return this.pollTimer !== null;
  }

  start(): void {
    if (this.pollTimer) return;
    const { pollIntervalMs, remindIntervalMs } = this.deps.config;
    this.pollTimer = setInterval(() => void this.tickPoll(), pollIntervalMs);
    this.remindTimer = setInterval(() => void this.tickRemind(), remindIntervalMs);
    log.info(
      `Started: poll=${pollIntervalMs / 60_000}min remind=${remindIntervalMs / 60_000}min chat=${this.deps.config.remindChatId}`,
    );
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.remindTimer) clearInterval(this.remindTimer);
    this.pollTimer = null;
    this.remindTimer = null;
    log.info("Stopped");
  }

  // ─── Poll ───────────────────────────────────────────────────

  async tickPoll(): Promise<void> {
    if (this.polling) {
      log.warn("Poll skipped: previous tick still running");
      return;
    }
    this.polling = true;
    try {
      await this.runPoll();
    } catch (err) {
      log.error(`Poll failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.polling = false;
    }
  }

  private async runPoll(): Promise<void> {
    const { memory, readInbox, sendNotify, config } = this.deps;
    const lastIdStr = memory.getFocus(LAST_ID_KEY);
    const lastId = lastIdStr ? Number.parseInt(lastIdStr, 10) : 0;

    const inbox = await readInbox(config.remindChatId, 50);
    const fresh = inbox.filter((m) => m.id > lastId && m.text).sort((a, b) => a.id - b.id);
    if (!fresh.length) return;

    let state = this.readState();
    const now = () => Math.floor(Date.now() / 1000);

    for (const msg of fresh) {
      const cmd = parseCommand(msg.text);
      if (cmd.kind === "unknown") continue;
      const res = applyCommand(state, cmd, now());
      state = res.state;
      try {
        await sendNotify(res.receipt);
      } catch (err) {
        log.error(`Notify failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    this.writeState(state);
    const maxId = fresh[fresh.length - 1].id;
    memory.setFocus(LAST_ID_KEY, String(maxId));
  }

  // ─── Remind ─────────────────────────────────────────────────

  async tickRemind(): Promise<void> {
    if (this.reminding) {
      log.warn("Remind skipped: previous tick still running");
      return;
    }
    this.reminding = true;
    try {
      await this.runRemind();
    } catch (err) {
      log.error(`Remind failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.reminding = false;
    }
  }

  private async runRemind(): Promise<void> {
    const { router, sendNotify, config } = this.deps;
    const state = this.readState();
    const now = Math.floor(Date.now() / 1000);
    const candidates = collectRemindCandidates(state, now, config.staleHours * 3600);
    if (!candidates.length) return;

    const prompt = buildRemindPrompt(candidates, state);
    const resp = await router.chat(
      config.remindModel,
      {
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        max_tokens: 200,
      },
      "low",
    );
    const text = resp.choices?.[0]?.message?.content?.trim();
    if (!text) return;
    await sendNotify(text);
  }

  // ─── State helpers ──────────────────────────────────────────

  private readState(): TaskState {
    const raw = this.deps.memory.getFocus(TASK_STATE_KEY);
    if (!raw) return emptyState();
    try {
      const parsed = JSON.parse(raw);
      return {
        "tasks.work": Array.isArray(parsed["tasks.work"]) ? parsed["tasks.work"] : [],
        "tasks.home": Array.isArray(parsed["tasks.home"]) ? parsed["tasks.home"] : [],
      };
    } catch {
      return emptyState();
    }
  }

  private writeState(state: TaskState): void {
    this.deps.memory.setFocus(TASK_STATE_KEY, JSON.stringify(state));
  }
}

export const TASK_STATE_FOCUS_KEY = TASK_STATE_KEY;
export const LAST_ID_FOCUS_KEY = LAST_ID_KEY;
