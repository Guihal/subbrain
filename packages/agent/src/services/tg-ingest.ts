/**
 * Telegram message ingest helpers — pure, no DB access.
 * Called before rows reach the repository layer.
 */
import { scrubPII } from "@subbrain/core/lib/pii-scrub";
import type { TgMessageInsert } from "@subbrain/core/db/tables/tg-messages";

/** Return a copy of the row with text scrubbed for PII. */
export function applyAtIngest(row: TgMessageInsert): TgMessageInsert {
  return {
    ...row,
    text: scrubPII(row.text ?? "").scrubbed,
  };
}
