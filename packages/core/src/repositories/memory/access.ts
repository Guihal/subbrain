import type { Database } from "bun:sqlite";

type Layer = "shared" | "context" | "archive";

function tableFor(layer: Layer): string {
  return layer === "shared"
    ? "shared_memory"
    : layer === "context"
      ? "layer2_context"
      : "layer3_archive";
}

/**
 * M-02 + M-03 (mig 10/13): bump `last_accessed_at` and `access_count` for a
 * batch of rows in a single layer; reinforce salience with an exponential
 * recency bonus. Called by RAG retrieval after rerank.
 *
 * Empty `ids` is an early-return (SQLite rejects empty `IN ()` at parse).
 * `layer` is closed-union, table name from a switch — no injection surface.
 * Single UPDATE — single-statement writes are atomic in SQLite, no tx needed.
 *
 * Salience bonus = 0.05 * exp(-age_days / 7) capped at 1.0. First-ever hit
 * (last_accessed_at IS NULL) → COALESCE proxies to `now` → age=0 → bonus=0.05.
 */
export function bumpAccess(db: Database, layer: Layer, ids: string[]): void {
  if (ids.length === 0) return;
  const table = tableFor(layer);
  const placeholders = ids.map(() => "?").join(",");
  // unix-seconds — matches schema (created_at/updated_at/expires_at all
  // use unixepoch()). M-08 Ebbinghaus decay would silently 1000× over-age
  // if we wrote ms here.
  const now = Math.floor(Date.now() / 1000);
  db.query(
    `UPDATE ${table}
        SET last_accessed_at = ?,
            access_count = access_count + 1,
            salience = MIN(
              1.0,
              salience + 0.05 * EXP(
                -CAST(? - COALESCE(last_accessed_at, ?) AS REAL) / (7.0 * 86400.0)
              )
            )
      WHERE id IN (${placeholders})`,
  ).run(now, now, now, ...ids);
}

/**
 * M-03 (mig 13): multiply `salience` by `0.98 ^ days_since_last_decayed` for
 * every row in a layer that has ever been accessed. Returns rows affected.
 *
 * Idempotency: when `last_decayed_at` set, age = (now - last_decayed) →
 * re-running same day is a no-op. First run after migration:
 * `last_decayed_at IS NULL` → proxy to `last_accessed_at`. Rows never
 * accessed (both NULL) filtered out. Floor: salience <= 0.001 skipped.
 *
 * `now` from caller — a single night-cycle pass uses one consistent ts.
 * MAX(0, ...) clamps a future last_decayed_at (clock skew) so salience
 * never inflates from a negative age.
 */
export function decaySalience(db: Database, layer: Layer, now: number): number {
  const table = tableFor(layer);
  const result = db
    .query(
      `UPDATE ${table}
        SET salience = salience * POW(
              0.98,
              MAX(
                0.0,
                CAST(? - COALESCE(last_decayed_at, last_accessed_at) AS REAL) / 86400.0
              )
            ),
            last_decayed_at = ?
      WHERE COALESCE(last_decayed_at, last_accessed_at) IS NOT NULL
        AND salience > 0.001`,
    )
    .run(now, now);
  return result.changes;
}
