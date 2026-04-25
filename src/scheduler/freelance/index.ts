import type { MemoryDB } from "../../db";
import type { ModelRouter } from "../../lib/model-router";
import type { PlaywrightClient } from "../../mcp/playwright-client";
import { pageSnapshot } from "../../mcp/snapshot";
import type { TelegramBot } from "../../telegram/bot";
import type { FreelanceSource } from "../../db/types";
import { logger } from "../../lib/logger";
import { fetchFeed } from "./fetch";
import { evaluateLead } from "./evaluate";
import { saveAndAlert, isSeen } from "./persist";
import type { FeedItem, ScoutStatus } from "./types";

const SOURCES: FreelanceSource[] = ["fl.ru", "kwork.ru", "freelance.ru"];
const SCOPE_PREFIX = "freelance:";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const PAUSE_MS = 6 * 60 * 60 * 1000;
const EVALUATE_TIMEOUT_MS = 30_000;

const log = logger.child("freelance");

export interface FreelanceScoutConfig {
  enabled: boolean;
  pollMs: number;
  categories: string[];
  minBudget: number;
  maxBudget: number;
  threshold: number;
  tgChatId: number | null;
}

export interface FreelanceScoutDeps {
  db: MemoryDB;
  router: ModelRouter;
  playwright: PlaywrightClient;
  bot: TelegramBot | null;
  config: FreelanceScoutConfig;
  /** Injectable snapshot fn (tests). Default = page.content()-based snapshot. */
  snapshot?: (page: import("playwright").Page) => Promise<string>;
}

export class FreelanceScout {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private abort = new AbortController();
  private pausedUntil = new Map<string, number>();
  private lastRunAt: number | null = null;
  private readonly snapshot: (
    page: import("playwright").Page,
  ) => Promise<string>;

  constructor(private deps: FreelanceScoutDeps) {
    this.snapshot = deps.snapshot ?? pageSnapshot;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    const ms = this.deps.config.pollMs;
    void this.tick("startup");
    this.timer = setInterval(() => void this.tick("interval"), ms);
    log.info("freelance scout started", { meta: { pollMs: ms } });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.abort.abort("shutdown");
    await Promise.allSettled(
      SOURCES.map((s) => this.deps.playwright.closeScope(SCOPE_PREFIX + s)),
    );
    log.info("freelance scout stopped");
  }

  status(): ScoutStatus {
    return {
      running: this.running,
      pausedUntil: [...this.pausedUntil.entries()],
      lastRunAt: this.lastRunAt,
      lastLeadAt: this.deps.db.lastFreelanceLeadAt(),
      leadsToday: this.deps.db.countFreelanceLeadsSince(
        Math.floor((Date.now() - ONE_DAY_MS) / 1000),
      ),
    };
  }

  private async tick(kind: string): Promise<void> {
    this.lastRunAt = Date.now();
    log.info(`tick ${kind}`);
    const settled = await Promise.allSettled(
      SOURCES.map((s) => this.scoutOne(s)),
    );
    for (const [i, r] of settled.entries()) {
      if (r.status === "rejected") {
        log.warn(`scout failed: ${SOURCES[i]}`, {
          meta: { err: String(r.reason) },
        });
      }
    }
  }

  private async scoutOne(source: FreelanceSource): Promise<void> {
    const now = Date.now();
    const pausedTs = this.pausedUntil.get(source) ?? 0;
    if (pausedTs > now) {
      log.info("skip paused", { meta: { source, until: pausedTs } });
      return;
    }
    const page = await this.deps.playwright.getScopePage(SCOPE_PREFIX + source);
    const { items, blocked } = await fetchFeed(source, page, {
      snapshot: this.snapshot,
    });
    if (blocked) return this.pauseDomain(source);
    for (const item of items) {
      if (this.abort.signal.aborted) return;
      if (!this.passPrefilter(item)) continue;
      if (isSeen(this.deps.db, item.url)) continue;
      await sleep(randBetween(5_000, 15_000), this.abort.signal);
      const composed = AbortSignal.any([
        this.abort.signal,
        AbortSignal.timeout(EVALUATE_TIMEOUT_MS),
      ]);
      try {
        const ev = await evaluateLead(this.deps.router, item, composed);
        if (ev.score < this.deps.config.threshold) continue;
        await saveAndAlert(
          {
            db: this.deps.db,
            bot: this.deps.bot,
            alertChatId: this.deps.config.tgChatId,
          },
          item,
          ev,
        );
      } catch (err) {
        log.warn("evaluate failed", {
          meta: { err: String(err), url: item.url },
        });
      }
    }
  }

  private passPrefilter(item: FeedItem): boolean {
    const cfg = this.deps.config;
    if (cfg.categories.length > 0 && item.category) {
      if (!cfg.categories.includes(item.category.toLowerCase())) return false;
    }
    if (item.budget !== null) {
      if (item.budget < cfg.minBudget || item.budget > cfg.maxBudget) {
        return false;
      }
    }
    if (item.deadlineDays !== null && item.deadlineDays < 1) return false;
    return true;
  }

  private async pauseDomain(source: FreelanceSource): Promise<void> {
    const until = Date.now() + PAUSE_MS;
    this.pausedUntil.set(source, until);
    log.warn(`rate-limited ${source}`, { meta: { until } });
    if (this.deps.bot && this.deps.config.tgChatId !== null) {
      try {
        await this.deps.bot.notify(
          `⚠️ ${source} rate-limited, пауза до ${new Date(until).toISOString()}`,
        );
      } catch {
        /* ignore */
      }
    }
  }
}

function randBetween(a: number, b: number): number {
  return a + Math.floor(Math.random() * (b - a));
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    });
  });
}
