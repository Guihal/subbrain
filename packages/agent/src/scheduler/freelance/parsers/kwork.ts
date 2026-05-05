import type { FeedItem } from "../types";
import { parseSnapshot } from "./shared";

export function parseKwork(snapshot: string): FeedItem[] {
  return parseSnapshot(snapshot, {
    source: "kwork.ru",
    projectLinkRe: /→\s+(https?:\/\/(?:www\.)?kwork\.ru\/projects\/\d+[^\s]*)/,
    titleLinkRe: /"([^"]+)"\s+→\s+(https?:\/\/(?:www\.)?kwork\.ru\/projects\/\d+[^\s]*)/,
  });
}
