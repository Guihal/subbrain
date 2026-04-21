import type { FeedItem } from "../types";
import type { FreelanceSource } from "../../../db/types";

const BUDGET_RE = /(\d[\d\s]{2,})\s*(?:руб|₽|RUB)/i;
const DEADLINE_RE = /(?:до|срок|дедлайн)[^\d]*(\d+)\s*(?:дн|день|дня|дней)/i;

export interface ParserOpts {
  source: FreelanceSource;
  projectLinkRe: RegExp;
  titleLinkRe: RegExp;
}

export function parseSnapshot(snapshot: string, opts: ParserOpts): FeedItem[] {
  const textBlock = extractTextBlock(snapshot);
  const lines = snapshot.split("\n");
  const items: FeedItem[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const titleMatch = opts.titleLinkRe.exec(line);
    const linkMatch = titleMatch ?? opts.projectLinkRe.exec(line);
    if (!linkMatch) continue;
    const rawUrl = titleMatch ? titleMatch[2]! : linkMatch[1]!;
    const url = normalizeUrl(rawUrl);
    if (seen.has(url)) continue;
    seen.add(url);
    const title = titleMatch ? titleMatch[1]! : extractInlineTitle(line);
    const textLine = findTextLine(textBlock, title);
    items.push({
      url,
      source: opts.source,
      title: title || "(no title)",
      budget: extractNumber(textLine, BUDGET_RE, (s) =>
        Number(s.replace(/\s+/g, "")),
      ),
      deadlineDays: extractNumber(textLine, DEADLINE_RE, (s) => Number(s)),
      category: null,
      description: textLine,
    });
  }
  return items;
}

function normalizeUrl(raw: string): string {
  return raw.split("?")[0]!.replace(/\/$/, "");
}

function extractInlineTitle(line: string): string {
  const m = /"([^"]+)"/.exec(line);
  return m ? m[1]!.slice(0, 200) : "";
}

function extractTextBlock(snapshot: string): string {
  const marker = "\nText:\n";
  const idx = snapshot.indexOf(marker);
  return idx < 0 ? "" : snapshot.slice(idx + marker.length);
}

function findTextLine(textBlock: string, title: string): string {
  if (!title || !textBlock) return "";
  const key = firstWord(title);
  if (!key) return "";
  for (const line of textBlock.split("\n")) {
    if (line.toLowerCase().includes(key.toLowerCase())) return line;
  }
  return "";
}

function firstWord(title: string): string {
  const m = /[\p{L}]{3,}/u.exec(title);
  return m ? m[0] : "";
}

function extractNumber(
  line: string,
  re: RegExp,
  cast: (s: string) => number,
): number | null {
  if (!line) return null;
  const m = re.exec(line);
  if (!m) return null;
  const n = cast(m[1]!);
  return Number.isFinite(n) ? n : null;
}
