import type { FeedItem } from "../types";
import { parseSnapshot } from "./shared";

export function parseFreelance(snapshot: string): FeedItem[] {
  return parseSnapshot(snapshot, {
    source: "freelance.ru",
    projectLinkRe: /→\s+(https?:\/\/(?:www\.)?freelance\.ru\/projects\/[^\s]+\.html)/,
    titleLinkRe: /"([^"]+)"\s+→\s+(https?:\/\/(?:www\.)?freelance\.ru\/projects\/[^\s]+\.html)/,
  });
}
