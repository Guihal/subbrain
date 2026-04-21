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

const log = logger.child("playwright");

const NAV_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 10_000;
const MAX_INTERACTIVE_ELEMENTS = 200;
const MAX_TEXT_PREVIEW = 3000;
const MAX_ELEMENT_LABEL = 120;

const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input:not([type=hidden])",
  "textarea",
  "select",
  "[role=button]",
  "[role=link]",
  "[role=textbox]",
  "[role=combobox]",
  "[role=checkbox]",
  "[role=radio]",
  "[role=tab]",
  "[role=menuitem]",
  "[contenteditable=true]",
].join(", ");

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

  constructor() {
    liveClients.add(this);
    registerBeforeExit();
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
    const page = this.page!;
    const url = page.url();
    const title = await page.title().catch(() => "");

    const collected = await page
      .evaluate(
        ({ sel, maxLabel, maxCount }) => {
          document
            .querySelectorAll("[data-pw-ref]")
            .forEach((el) => el.removeAttribute("data-pw-ref"));

          const isVisible = (el: Element): boolean => {
            const r = (el as HTMLElement).getBoundingClientRect();
            if (r.width === 0 && r.height === 0) return false;
            const style = window.getComputedStyle(el as HTMLElement);
            if (style.display === "none" || style.visibility === "hidden")
              return false;
            return true;
          };

          const label = (el: HTMLElement): string => {
            const texts = [
              (el.getAttribute("aria-label") || "").trim(),
              (el.innerText || "").trim(),
              (el.getAttribute("title") || "").trim(),
              (el.getAttribute("placeholder") || "").trim(),
              ((el as HTMLInputElement).value || "").trim(),
              (el.getAttribute("alt") || "").trim(),
              (el.getAttribute("name") || "").trim(),
            ];
            for (const t of texts) if (t) return t.slice(0, maxLabel);
            return "";
          };

          const nodes = Array.from(document.querySelectorAll(sel));
          const out: Array<{
            ref: string;
            role: string;
            type?: string;
            name: string;
            href?: string;
          }> = [];
          let counter = 0;
          for (const n of nodes) {
            if (!isVisible(n)) continue;
            counter++;
            if (counter > maxCount) break;
            const el = n as HTMLElement;
            const ref = String(counter);
            el.setAttribute("data-pw-ref", ref);
            const tag = n.tagName.toLowerCase();
            const role = el.getAttribute("role") || tag;
            const type =
              tag === "input" ? (n as HTMLInputElement).type : undefined;
            const href =
              tag === "a" ? (n as HTMLAnchorElement).href || undefined : undefined;
            out.push({ ref, role, type, name: label(el), href });
          }
          return out;
        },
        {
          sel: INTERACTIVE_SELECTOR,
          maxLabel: MAX_ELEMENT_LABEL,
          maxCount: MAX_INTERACTIVE_ELEMENTS,
        },
      )
      .catch((): Array<never> => []);

    const textPreview = await page
      .evaluate((max: number) => (document.body?.innerText || "").slice(0, max), MAX_TEXT_PREVIEW)
      .catch(() => "");

    const lines: string[] = [];
    lines.push(`URL: ${url}`);
    lines.push(`Title: ${title}`);
    if (collected.length > 0) {
      lines.push("");
      lines.push(`Interactive elements (${collected.length}):`);
      for (const el of collected) {
        let line = `[${el.ref}] ${el.role}`;
        if (el.type && el.type !== el.role) line += `(${el.type})`;
        if (el.name) line += ` "${el.name}"`;
        if (el.href) line += ` → ${el.href}`;
        lines.push(line);
      }
    }
    if (textPreview) {
      lines.push("");
      lines.push("Text:");
      lines.push(textPreview);
    }
    return lines.join("\n");
  }
}

/** Escape a ref for use inside a CSS attribute selector value. */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}
