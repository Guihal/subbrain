import type { FeedItem } from "../types";
import { parseSnapshot } from "./shared";

export function parseFl(snapshot: string): FeedItem[] {
  return parseSnapshot(snapshot, {
    source: "fl.ru",
    projectLinkRe: /→\s+(https?:\/\/(?:www\.)?fl\.ru\/projects\/\d+[^\s]*)/,
    titleLinkRe: /"([^"]+)"\s+→\s+(https?:\/\/(?:www\.)?fl\.ru\/projects\/\d+[^\s]*)/,
  });
}
