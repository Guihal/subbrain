/// <reference lib="dom" />
/** Direct Playwright browser wrapper. See docs/02-audit.md BROWSER-1. */
import type { Browser, BrowserContext, Page } from "playwright";
import { logger } from "../../lib/logger";
import * as a from "./actions";
import { launchBrowser, newScopeContext, trackClient, untrackClient } from "./lifecycle";

const log = logger.child("playwright");

export class PlaywrightClient {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private launchPromise: Promise<void> | null = null;
  private scopes = new Map<string, { ctx: BrowserContext; page: Page }>();

  constructor() {
    trackClient(this);
  }

  async getScopePage(name: string): Promise<Page> {
    await this.ensureLaunched();
    const existing = this.scopes.get(name);
    if (existing && !existing.page.isClosed()) return existing.page;
    const fresh = await newScopeContext(this.browser!);
    this.scopes.set(name, fresh);
    return fresh.page;
  }

  async closeScope(name: string): Promise<void> {
    const s = this.scopes.get(name);
    if (!s) return;
    try {
      await s.ctx.close();
    } catch {
      /* ignore */
    }
    this.scopes.delete(name);
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<string> {
    try {
      await this.ensureLaunched();
      const p = this.page!;
      switch (name) {
        case "browser_navigate":
          return await a.navigate(p, String(args.url ?? ""));
        case "browser_snapshot":
          return await a.snapshot(p);
        case "browser_click":
          return await a.click(p, String(args.ref ?? ""));
        case "browser_type":
          return await a.type(
            p,
            String(args.ref ?? ""),
            String(args.text ?? ""),
            Boolean(args.submit),
          );
        case "browser_go_back":
          return await a.goBack(p);
        case "browser_press_key":
          return await a.pressKey(p, String(args.key ?? ""));
        case "browser_scroll":
          return await a.scroll(p, Number(args.dy ?? 800), Number(args.dx ?? 0));
        case "browser_screenshot":
          return await a.screenshot(p, Boolean(args.full_page));
        case "browser_close":
          await this.close();
          return "OK";
        default:
          return JSON.stringify({ error: `Unknown tool: ${name}` });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`${name} failed: ${msg}`);
      // On fatal errors (crashed page, closed browser), reset for next call.
      if (
        /Target page, context or browser has been closed|browserContext|Protocol error/i.test(msg)
      ) {
        await this.close();
      }
      return JSON.stringify({ error: msg });
    }
  }

  listTools(): Promise<Array<{ name: string; description?: string }>> {
    return Promise.resolve(a.TOOL_LIST);
  }

  async close(): Promise<void> {
    for (const [, s] of this.scopes) {
      try {
        await s.ctx.close();
      } catch {
        /* ignore */
      }
    }
    this.scopes.clear();
    try {
      await this.context?.close();
    } catch {
      /* ignore */
    }
    try {
      await this.browser?.close();
    } catch {
      /* ignore */
    }
    this.browser = null;
    this.context = null;
    this.page = null;
    this.launchPromise = null;
    untrackClient(this);
  }

  get connected(): boolean {
    return this.browser !== null && this.page !== null;
  }

  /** How many browser contexts are currently open (0 or 1 in practice). */
  get contextCount(): number {
    return this.browser?.contexts().length ?? 0;
  }

  private async ensureLaunched(): Promise<void> {
    if (this.browser && this.page && !this.page.isClosed()) return;
    if (this.launchPromise) return this.launchPromise;
    this.launchPromise = this.launch().catch((err) => {
      this.launchPromise = null;
      throw err;
    });
    return this.launchPromise;
  }

  private async launch(): Promise<void> {
    const { browser, context, page } = await launchBrowser();
    this.browser = browser;
    this.context = context;
    this.page = page;
    browser.on("disconnected", () => {
      log.warn("Browser disconnected — will relaunch on next call");
      this.browser = null;
      this.context = null;
      this.page = null;
      this.launchPromise = null;
    });
  }
}
