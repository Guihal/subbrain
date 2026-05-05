import type { FreelanceSource } from "../../../db/types";
import type { FeedItem } from "../types";
import { parseFl } from "./fl";
import { parseFreelance } from "./freelance";
import { parseKwork } from "./kwork";

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

export { parseFl, parseFreelance, parseKwork };
