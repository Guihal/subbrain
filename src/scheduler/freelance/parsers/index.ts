import { parseFl } from "./fl";
import { parseKwork } from "./kwork";
import { parseFreelance } from "./freelance";
import type { FeedItem } from "../types";
import type { FreelanceSource } from "../../../db/types";

export function parseFor(source: FreelanceSource, snapshot: string): FeedItem[] {
  switch (source) {
    case "fl.ru":
      return parseFl(snapshot);
    case "kwork.ru":
      return parseKwork(snapshot);
    case "freelance.ru":
      return parseFreelance(snapshot);
  }
}

export { parseFl, parseKwork, parseFreelance };
