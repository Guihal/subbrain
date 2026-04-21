import { parseSnapshot } from "./shared";
import type { FeedItem } from "../types";

export function parseFreelance(snapshot: string): FeedItem[] {
  return parseSnapshot(snapshot, {
    source: "freelance.ru",
    projectLinkRe:
      /→\s+(https?:\/\/(?:www\.)?freelance\.ru\/project\/\d+[^\s]*)/,
    titleLinkRe:
      /"([^"]+)"\s+→\s+(https?:\/\/(?:www\.)?freelance\.ru\/project\/\d+[^\s]*)/,
  });
}
