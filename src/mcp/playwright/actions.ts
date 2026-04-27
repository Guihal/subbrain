/// <reference lib="dom" />
import type { Page } from "playwright";
import { pageSnapshot } from "../snapshot";
import { ACTION_TIMEOUT_MS, NAV_TIMEOUT_MS, cssEscape } from "./lifecycle";

export function snapshot(page: Page): Promise<string> {
  return pageSnapshot(page);
}

export async function navigate(page: Page, url: string): Promise<string> {
  if (!url) return JSON.stringify({ error: "url required" });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
  // Best-effort settle for dynamic pages (don't block on slow trackers).
  await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
  return snapshot(page);
}

export async function click(page: Page, ref: string): Promise<string> {
  if (!ref) return JSON.stringify({ error: "ref required" });
  const sel = `[data-pw-ref="${cssEscape(ref)}"]`;
  await page.click(sel, { timeout: ACTION_TIMEOUT_MS });
  await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
  return snapshot(page);
}

export async function type(page: Page, ref: string, text: string, submit: boolean): Promise<string> {
  if (!ref) return JSON.stringify({ error: "ref required" });
  const sel = `[data-pw-ref="${cssEscape(ref)}"]`;
  await page.fill(sel, text, { timeout: ACTION_TIMEOUT_MS });
  if (submit) {
    await page.press(sel, "Enter", { timeout: ACTION_TIMEOUT_MS });
    await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
  }
  return snapshot(page);
}

export async function goBack(page: Page): Promise<string> {
  await page.goBack({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {});
  return snapshot(page);
}

export async function pressKey(page: Page, key: string): Promise<string> {
  if (!key) return JSON.stringify({ error: "key required" });
  await page.keyboard.press(key);
  await page.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => {});
  return snapshot(page);
}

export async function scroll(page: Page, dy: number, dx: number): Promise<string> {
  await page.evaluate(
    ({ dx, dy }: { dx: number; dy: number }) =>
      window.scrollBy({ left: dx, top: dy, behavior: "instant" as ScrollBehavior }),
    { dx, dy },
  );
  await page.waitForLoadState("networkidle", { timeout: 2000 }).catch(() => {});
  return snapshot(page);
}

export async function screenshot(page: Page, fullPage: boolean): Promise<string> {
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

export const TOOL_LIST = [
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
