import type { FreelanceSource } from "../../../db/types";
import type { FeedItem } from "../types";

const BUDGET_RE = /(\d[\d\s]{2,})\s*(?:руб|₽|RUB)/i;
const DEADLINE_RE = /(?:до|срок|дедлайн)[^\d]*(\d+)\s*(?:дн|день|дня|дней)/i;

export interface ParserOpts {
  source: FreelanceSource;
  projectLinkRe: RegExp;
  titleLinkRe: RegExp;
}

// UI-only strings that appear as anchors sharing the project URL but are
// not the listing title (action buttons, status badges, response counters).
const TITLE_NOISE_RE =
  /^(откликнуться|исполнитель\s+определ|\d+\s+(ответ|участник|предложен)|подробнее)/i;

export function parseSnapshot(snapshot: string, opts: ParserOpts): FeedItem[] {
  const textBlock = extractTextBlock(snapshot);
  const lines = snapshot.split("\n");

  // Pass 1: collect titled-link occurrences per URL **in document order**.
  // Listing cards put the real title first; later anchors with the same href
  // are typically action buttons ("Откликнуться", "12 ответов") or, on
  // freelance.ru, a longer description preview.
  const byUrl = new Map<string, string[]>();
  for (const line of lines) {
    const titleMatch = opts.titleLinkRe.exec(line);
    const linkMatch = titleMatch ?? opts.projectLinkRe.exec(line);
    if (!linkMatch) continue;
    const rawUrl = titleMatch ? titleMatch[2]! : linkMatch[1]!;
    const url = normalizeUrl(rawUrl);
    if (!byUrl.has(url)) byUrl.set(url, []);
    if (titleMatch) {
      const text = titleMatch[1]?.trim();
      if (text && !TITLE_NOISE_RE.test(text)) byUrl.get(url)?.push(text);
    }
  }

  const items: FeedItem[] = [];
  for (const [url, titles] of byUrl) {
    if (titles.length === 0) continue; // skip promo / unlabelled links
    const title = titles[0]!;
    // Description = longest later occurrence (often a description preview on
    // freelance.ru). Falls back to the cards's text-block first line.
    const later = titles.slice(1);
    const desc = later.length > 0 ? later.sort((a, b) => b.length - a.length)[0]! : "";
    const block = findTextBlock(textBlock, title);
    items.push({
      url,
      source: opts.source,
      title,
      budget: extractNumber(block, BUDGET_RE, (s) => Number(s.replace(/\s+/g, ""))),
      deadlineDays: extractNumber(block, DEADLINE_RE, (s) => Number(s)),
      category: null,
      description: desc || block.split("\n")[0] || "",
    });
  }
  return items;
}

function normalizeUrl(raw: string): string {
  return raw.split("?")[0]?.replace(/\/$/, "");
}

function extractTextBlock(snapshot: string): string {
  const marker = "\nText:\n";
  const idx = snapshot.indexOf(marker);
  return idx < 0 ? "" : snapshot.slice(idx + marker.length);
}

/**
 * Return up to BLOCK_LINES lines starting from the first line that contains
 * the title's first word. Listing pages typically render a card as
 * `<title>\n<description>\nЖелаемый бюджет: до 5 000 ₽\n...`, so a small
 * window is enough to cover budget + deadline.
 */
function findTextBlock(textBlock: string, title: string): string {
  if (!title || !textBlock) return "";
  const key = firstWord(title);
  if (!key) return "";
  const lines = textBlock.split("\n");
  const lower = key.toLowerCase();
  const idx = lines.findIndex((l) => l.toLowerCase().includes(lower));
  if (idx < 0) return "";
  const BLOCK_LINES = 12;
  return lines.slice(idx, idx + BLOCK_LINES).join("\n");
}

function firstWord(title: string): string {
  const m = /[\p{L}]{3,}/u.exec(title);
  return m ? m[0] : "";
}

function extractNumber(line: string, re: RegExp, cast: (s: string) => number): number | null {
  if (!line) return null;
  const m = re.exec(line);
  if (!m) return null;
  const n = cast(m[1]!);
  return Number.isFinite(n) ? n : null;
}
