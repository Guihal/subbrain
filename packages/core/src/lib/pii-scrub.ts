/**
 * PII scrub primitive — pure synchronous function.
 * Replaces email, phone, IBAN, credit-card, Russian passport,
 * Russian INN, street-address lines, and IPv4 with [REDACTED:<type>].
 * Idempotent: does not double-redact existing [REDACTED:*] markers.
 */

export type PiiType =
  | "email"
  | "phone"
  | "iban"
  | "card"
  | "passport_ru"
  | "inn_ru"
  | "address"
  | "ipv4";

export type ScrubResult = {
  scrubbed: string;
  redacted_count: number;
  types: PiiType[];
};

/** Guard against double-redacting our own markers. */
const ALREADY_REDACTED_RE = /\[REDACTED:\w+\]/g;

interface Rule {
  type: PiiType;
  regex: RegExp;
}

// Order matters: more specific before generic.
const RULES: Rule[] = [
  // Email — before phone to avoid partial match on numbers in local-part
  {
    type: "email",
    regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  },
  // IBAN — 2 letters + 2-34 alphanumeric
  {
    type: "iban",
    regex: /\b[A-Z]{2}\d{2}[A-Z0-9]{1,30}\b/g,
  },
  // Credit card — 13-19 digits with optional spaces/dashes
  {
    type: "card",
    regex: /\b(?:\d{4}[\s\-]?){3,4}\d{1,4}\b|\b\d{13,19}\b/g,
  },
  // Russian passport — 4 digits space 6 digits
  {
    type: "passport_ru",
    regex: /\b\d{4}\s\d{6}\b/g,
  },
  // Russian INN — 10 or 12 digits (word boundary, no overlap with passport)
  {
    type: "inn_ru",
    regex: /\b\d{10}(?!\d)\b|\b\d{12}\b/g,
  },
  // IPv4 — dotted quad
  {
    type: "ipv4",
    regex: /\b(?:25[0-5]|2[0-4]\d|1\d{1,2}|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d{1,2}|[1-9]?\d)){3}\b/g,
  },
  // Phone — +7, 8-xxx, international; require at least 10 digits total
  {
    type: "phone",
    regex:
      /\+?\d(?:[\d\s\-()]{8,}\d|\d{9,})/g,
  },
  // Street address heuristic — starts with a number, contains street keywords
  {
    type: "address",
    regex:
      /(?<=^|\s)(?:\d+[\p{L}\s,.-]*(?:street|st|road|rd|avenue|ave|boulevard|blvd|lane|ln|drive|dr|way|court|ct|plaza|square|проспект|ул\.|улица|переулок|пер\.|шоссе|ш\.|бульвар|бул\.|проезд|пр-д)|(?:проспект|ул\.|улица|переулок|пер\.|шоссе|ш\.|бульвар|бул\.|проезд|пр-д)[\p{L}\s,.-]*\d+)(?=\s|$|[.,;!?])/giu,
  },
];

export function scrubPII(text: string): ScrubResult {
  if (!text || text.length === 0) {
    return { scrubbed: text, redacted_count: 0, types: [] };
  }

  const types: PiiType[] = [];
  let redacted_count = 0;

  const protectedRanges: Array<{ start: number; end: number }> = [];
  for (const m of text.matchAll(ALREADY_REDACTED_RE)) {
    if (m.index !== undefined) {
      protectedRanges.push({ start: m.index, end: m.index + m[0].length });
    }
  }

  const matches: Array<{
    start: number;
    end: number;
    type: PiiType;
    replacement: string;
  }> = [];

  for (const rule of RULES) {
    const regex = new RegExp(rule.regex.source, rule.regex.flags);
    for (const m of text.matchAll(regex)) {
      if (m.index === undefined) continue;
      const start = m.index;
      const end = start + m[0].length;

      if (
        protectedRanges.some(
          (r) => (start >= r.start && start < r.end) || (end > r.start && end <= r.end),
        )
      ) {
        continue;
      }

      if (m[0].startsWith("[REDACTED:")) continue;

      // Skip phone matches that are actually IBANs, cards, passport, INN, or IPv4
      if (rule.type === "phone") {
        const insideOther = matches.some(
          (x) =>
            (x.type === "iban" || x.type === "card" || x.type === "passport_ru" || x.type === "inn_ru" || x.type === "ipv4") &&
            start >= x.start && end <= x.end,
        );
        if (insideOther) continue;
      }

      matches.push({
        start,
        end,
        type: rule.type,
        replacement: `[REDACTED:${rule.type}]`,
      });
    }
  }

  matches.sort((a, b) => b.start - a.start);

  const deduped: typeof matches = [];
  for (const m of matches) {
    const overlaps = deduped.some(
      (d) => m.start < d.end && m.end > d.start,
    );
    if (!overlaps) {
      deduped.push(m);
    }
  }

  deduped.sort((a, b) => b.start - a.start);

  let scrubbed = text;
  for (const m of deduped) {
    scrubbed = scrubbed.slice(0, m.start) + m.replacement + scrubbed.slice(m.end);
    redacted_count += 1;
    types.push(m.type);
  }

  types.reverse();

  return { scrubbed, redacted_count, types };
}
