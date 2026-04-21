import type { Page } from "playwright";
import type { FeedItem } from "./types";
import type { FreelanceSource } from "../../db/types";
import { parseFor } from "./parsers";

const FEED_URLS: Record<FreelanceSource, string> = {
  "fl.ru": "https://www.fl.ru/projects/",
  "kwork.ru": "https://kwork.ru/projects",
  "freelance.ru": "https://freelance.ru/project",
};

const ANTI_BOT_MARKERS = [
  "Проверьте, что вы не робот",
  "Captcha",
  "cf-challenge",
  "Just a moment",
  "Access denied",
  "Too many requests",
];

export interface FetchResult {
  items: FeedItem[];
  blocked: boolean;
}

/**
 * Navigates the given scope page to the source's feed and parses it.
 * Returns `blocked: true` if the page looks like an anti-bot wall — caller
 * should pause this domain.
 */
export async function fetchFeed(
  source: FreelanceSource,
  page: Page,
  opts: { snapshot: (p: Page) => Promise<string> },
): Promise<FetchResult> {
  const url = FEED_URLS[source];
  const resp = await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  const status = resp?.status() ?? 0;
  if (status === 429) return { items: [], blocked: true };
  const snapshot = await opts.snapshot(page);
  if (ANTI_BOT_MARKERS.some((m) => snapshot.includes(m))) {
    return { items: [], blocked: true };
  }
  return { items: parseFor(source, snapshot), blocked: false };
}
