/**
 * Backfill: scrub PII from all existing tg_messages rows.
 *
 * Usage:
 *   bun run scripts/tg-pii-backfill.ts --confirm
 *
 * Requires: DB_PATH (optional, default data/subbrain.db).
 * Destructive: original plaintext is overwritten. Recovery = re-run tg-reindex.ts.
 */

import { Database } from "bun:sqlite";
import { scrubPII } from "../packages/core/src/lib/pii-scrub";

function main(): void {
  if (!process.argv.includes("--confirm")) {
    console.error("tg-pii-backfill: destructive backfill of PII scrubbing on tg_messages");
    console.error("Usage: bun run scripts/tg-pii-backfill.ts --confirm");
    console.error(
      "Warning: original plaintext will be overwritten. Recovery = re-run tg-reindex.ts",
    );
    process.exit(1);
  }

  const dbPath = process.env.DB_PATH || "data/subbrain.db";
  const db = new Database(dbPath);

  const totalRow = db.query("SELECT COUNT(*) AS c FROM tg_messages").get() as { c: number };
  const total = totalRow.c;

  if (total === 0) {
    console.log("No rows to backfill");
    db.close();
    process.exit(0);
  }

  const selectQuery = db.query("SELECT rowid, text FROM tg_messages LIMIT 500 OFFSET ?");
  const updateStmt = db.query("UPDATE tg_messages SET text = ? WHERE rowid = ?");

  let processed = 0;
  let changed = 0;

  while (processed < total) {
    const rows = selectQuery.all(processed) as Array<{ rowid: number; text: string | null }>;
    if (rows.length === 0) break;

    db.transaction(() => {
      for (const row of rows) {
        const original = row.text ?? "";
        const result = scrubPII(original);
        if (result.scrubbed !== original) {
          updateStmt.run(result.scrubbed, row.rowid);
          changed++;
        }
      }
    })();

    processed += rows.length;

    if (processed % 1000 === 0 || processed >= total) {
      console.log(`Backfill: ${processed}/${total} rows processed (${changed} changed)`);
    }
  }

  db.close();
  console.log(`Done. ${processed} rows processed, ${changed} changed.`);
}

main();
