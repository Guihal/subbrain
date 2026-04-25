/// <reference lib="dom" />
/**
 * Direct Playwright browser wrapper (replaces the out-of-process @playwright/mcp
 * server, which hung on CDP WebSocket handshake in our Docker container — see
 * docs/02-audit.md BROWSER-1).
 *
 * Public API is the same method surface the rest of the code uses
 * (`callTool(name, args)`), so ToolExecutor / WebTools don't need to change.
 *
 * Ref system: each snapshot tags every interactive element in the live DOM
 * with `data-pw-ref="N"`, then subsequent clicks/types select by that
 * attribute. Refs are fresh per snapshot (old tags are stripped first) —
 * the agent must always call web_snapshot after a navigation or click
 * before referring to elements by ref.
 */
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { logger } from "../lib/logger";
import { pageSnapshot } from "./snapshot";

const log = logger.child("playwright");

const NAV_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 10_000;

/**
 * Tracks every live PlaywrightClient so the `beforeExit` hook can close
 * all of them — covers accidental leaks where an instance was not wired
 * into the shutdown handler (scripts, tests, REPL sessions).
 */
const liveClients = new Set<PlaywrightClient>();

let beforeExitRegistered = false;
function registerBeforeExit() {
  if (beforeExitRegistered) return;
  beforeExitRegistered = true;
  process.on("beforeExit", () => {
    for (const c of liveClients) {
      // Fire and forget — beforeExit doesn't await promises.
      void c.close().catch(() => {});
    }
  });
}

export class PlaywrightClient {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private launchPromise: Promise<void> | null = null;
  private scopes = new Map<string, { ctx: BrowserContext; page: Page }>();

  constructor() {
    liveClients.add(this);
    registerBeforeExit();
  }

  /**
   * Returns a dedicated incognito context+page bound to the given name.
   * Used by freelance-scout to avoid polluting the main browsing session.
   * Scope persists until closeScope(name) or client close().
   */
  async getScopePage(name: string): Promise<Page> {
    await this.ensureLaunched();
    const existing = this.scopes.get(name);
    if (existing && !existing.page.isClosed()) return existing.page;
    const ctx = await this.browser!.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      serviceWorkers: "block",
    });
    const page = await ctx.newPage();
    this.scopes.set(name, { ctx, page });
    return page;
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

  async callTool(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<string> {
    try {
      await this.ensureLaunched();
      switch (name) {
        case "browser_navigate":
          return await this.navigate(String(args.url ?? ""));
        case "browser_snapshot":
          return await this.snapshot();
        case "browser_click":
          return await this.click(String(args.ref ?? ""));
        case "browser_type":
          return await this.type(
            String(args.ref ?? ""),
            String(args.text ?? ""),
            Boolean(args.submit),
          );
        case "browser_go_back":
          return await this.goBack();
        case "browser_press_key":
          return await this.pressKey(String(args.key ?? ""));
        case "browser_scroll":
          return await this.scroll(
            Number(args.dy ?? 800),
            Number(args.dx ?? 0),
          );
        case "browser_screenshot":
          return await this.screenshot(Boolean(args.full_page));
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
        /Target page, context or browser has been closed|browserContext|Protocol error/i.test(
          msg,
        )
      ) {
        await this.reset();
      }
      return JSON.stringify({ error: msg });
    }
  }

  async listTools(): Promise<Array<{ name: string; description?: string }>> {
    return [
      { name: "browser_navigate", description: "Navigate to URL" },
      { name: "browser_snapshot", description: "Get current page snapshot" },
      { name: "browser_click", description: "Click element by ref" },
      { name: "browser_type", description: "Type into element by ref" },
      { name: "browser_go_back", description: "Navigate back" },
      { name: "browser_press_key", description: "Press a keyboard key" },
      { name: "browser_scroll", description: "Scroll the page by (dx, dy) pixels" },
      { name: "browser_screenshot", description: "Capture a PNG screenshot to /tmp" },
      { name: "browser_close", description: "Close the browser" },
    ];
  }

  async close(): Promise<void> {
    for (const [name, s] of this.scopes) {
      try {
        await s.ctx.close();
      } catch {
        /* ignore */
      }
      void name;
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
    liveClients.delete(this);
  }

  get connected(): boolean {
    return this.browser !== null && this.page !== null;
  }

  /** How many browser contexts are currently open (0 or 1 in practice). */
  get contextCount(): number {
    return this.browser?.contexts().length ?? 0;
  }

  // ─── Internal ──────────────────────────────────────────

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
    log.info("Launching Chrome (channel=chrome, headless)");
    this.browser = await chromium.launch({
      channel: "chrome",
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    });
    this.page = await this.context.newPage();
    this.browser.on("disconnected", () => {
      log.warn("Browser disconnected — will relaunch on next call");
      this.browser = null;
      this.context = null;
      this.page = null;
      this.launchPromise = null;
    });
  }

  private async reset(): Promise<void> {
    await this.close();
  }

  private async navigate(url: string): Promise<string> {
    if (!url) return JSON.stringify({ error: "url required" });
    await this.page!.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT_MS,
    });
    // Best-effort settle for dynamic pages (don't block on slow trackers).
    await this.page!.waitForLoadState("networkidle", { timeout: 3000 }).catch(
      () => {},
    );
    return this.snapshot();
  }

  private async click(ref: string): Promise<string> {
    if (!ref) return JSON.stringify({ error: "ref required" });
    const selector = `[data-pw-ref="${cssEscape(ref)}"]`;
    await this.page!.click(selector, { timeout: ACTION_TIMEOUT_MS });
    await this.page!.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(
      () => {},
    );
    return this.snapshot();
  }

  private async type(ref: string, text: string, submit: boolean): Promise<string> {
    if (!ref) return JSON.stringify({ error: "ref required" });
    const selector = `[data-pw-ref="${cssEscape(ref)}"]`;
    await this.page!.fill(selector, text, { timeout: ACTION_TIMEOUT_MS });
    if (submit) {
      await this.page!.press(selector, "Enter", { timeout: ACTION_TIMEOUT_MS });
      await this.page!.waitForLoadState("domcontentloaded", {
        timeout: 5000,
      }).catch(() => {});
    }
    return this.snapshot();
  }

  private async goBack(): Promise<string> {
    await this.page!.goBack({
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    }).catch(() => {});
    return this.snapshot();
  }

  private async pressKey(key: string): Promise<string> {
    if (!key) return JSON.stringify({ error: "key required" });
    await this.page!.keyboard.press(key);
    await this.page!.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(
      () => {},
    );
    return this.snapshot();
  }

  private async scroll(dy: number, dx: number): Promise<string> {
    const page = this.page!;
    await page.evaluate(
      ({ dx, dy }: { dx: number; dy: number }) =>
        window.scrollBy({ left: dx, top: dy, behavior: "instant" as ScrollBehavior }),
      { dx, dy },
    );
    // Give lazy-loaded content a moment to render.
    await page.waitForLoadState("networkidle", { timeout: 2000 }).catch(() => {});
    return this.snapshot();
  }

  private async screenshot(fullPage: boolean): Promise<string> {
    const page = this.page!;
    const ts = Date.now();
    const path = `/tmp/subbrain-shot-${ts}.png`;
    const buf = await page.screenshot({ path, fullPage, type: "png" });
    const url = page.url();
    const title = await page.title().catch(() => "");
    return [
      `Screenshot saved: ${path}`,
      `Size: ${buf.length} bytes`,
      `Page: ${title}`,
      `URL: ${url}`,
    ].join("\n");
  }

  private async snapshot(): Promise<string> {
    return pageSnapshot(this.page!);
  }
}

/** Escape a ref for use inside a CSS attribute selector value. */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}
