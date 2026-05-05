/// <reference lib="dom" />

import { logger } from "@subbrain/core/lib/logger";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";

const log = logger.child("playwright");

export const NAV_TIMEOUT_MS = 30_000;
export const ACTION_TIMEOUT_MS = 10_000;

export const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Escape a ref for use inside a CSS attribute selector value. */
export function cssEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

/**
 * Tracks every live client so the `beforeExit` hook can close all of them —
 * covers accidental leaks (scripts, tests, REPL) where the instance was not
 * wired into the shutdown handler.
 */
export interface ClientHandle {
  close(): Promise<void>;
}

const liveClients = new Set<ClientHandle>();
let beforeExitRegistered = false;

export function trackClient(c: ClientHandle): void {
  liveClients.add(c);
  if (beforeExitRegistered) return;
  beforeExitRegistered = true;
  process.on("beforeExit", () => {
    for (const cl of liveClients) void cl.close().catch(() => {});
  });
}

export function untrackClient(c: ClientHandle): void {
  liveClients.delete(c);
}

export async function launchBrowser(): Promise<{
  browser: Browser;
  context: BrowserContext;
  page: Page;
}> {
  log.info("Launching Chrome (channel=chrome, headless)");
  const browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: UA,
  });
  const page = await context.newPage();
  return { browser, context, page };
}

export async function newScopeContext(
  browser: Browser,
): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: UA,
    serviceWorkers: "block",
  });
  const page = await ctx.newPage();
  return { ctx, page };
}
