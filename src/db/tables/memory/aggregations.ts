import type { Database } from "bun:sqlite";
import type { ArchiveRow } from "../../types";

/**
 * M-06: aggregate active+fresh layer2_context rows by lower(title) (the
 * post-extractor "category"). Returns groups of size ≥ minGroup, age > 24h
 * proxied via `created_at < (now - 86400)`, access_count ≥ minAccess, not
 * superseded, not stale, title in caller-supplied whitelist. Top maxGroups
 * by count desc. Used by night-cycle reflect step.
 *
 * IDs and contents concatenated with '|' / '⟂' delimiters so a single
 * statement returns the group plus its members; caller splits in JS.
 */
export function reflectGroups(
  db: Database,
  whitelist: readonly string[],
  minAccess: number,
  minGroup: number,
  maxGroups: number,
): { category: string; n: number; ids: string; contents: string }[] {
  if (whitelist.length === 0) return [];
  const now = Math.floor(Date.now() / 1000);
  const olderThan = now - 86_400;
  const placeholders = whitelist.map(() => "?").join(",");
  const sql = `SELECT title AS category, COUNT(*) AS n,
                      GROUP_CONCAT(id, '|') AS ids,
                      GROUP_CONCAT(content, '⟂') AS contents
                 FROM layer2_context
                WHERE access_count >= ?
                  AND created_at < ?
                  AND status = 'active'
                  AND superseded_by IS NULL
                  AND (expires_at IS NULL OR expires_at > ?)
                  AND lower(title) IN (${placeholders})
                GROUP BY lower(title)
               HAVING n >= ?
                ORDER BY n DESC
                LIMIT ?`;
  return db.query(sql).all(minAccess, olderThan, now, ...whitelist, minGroup, maxGroups) as {
    category: string;
    n: number;
    ids: string;
    contents: string;
  }[];
}

/**
 * M-09: most-recent active+fresh context rows for cross-layer dedup. Returns
 * `cat = lower(title)` so the caller can match against shared.category /
 * archive.title without a second pass.
 */
export function recentActiveContextForCrossLayer(
  db: Database,
  limit: number,
): { id: string; cat: string; updated_at: number }[] {
  return db
    .query<{ id: string; cat: string; updated_at: number }, [number]>(
      "SELECT id, lower(title) AS cat, updated_at FROM layer2_context WHERE status='active' AND superseded_by IS NULL AND (expires_at IS NULL OR expires_at > unixepoch()) ORDER BY updated_at DESC LIMIT ?",
    )
    .all(limit);
}

/** M-09: most-recent archive rows for cross-layer dedup. Archive has no
 * status / superseded_by columns so unfiltered. */
export function recentArchiveForCrossLayer(
  db: Database,
  limit: number,
): { id: string; cat: string; updated_at: number }[] {
  return db
    .query<{ id: string; cat: string; updated_at: number }, [number]>(
      "SELECT id, lower(title) AS cat, updated_at FROM layer3_archive ORDER BY updated_at DESC LIMIT ?",
    )
    .all(limit);
}

/** M-09: archive promote candidates filtered by access_count + confidence. */
export function archivePromoteCandidates(
  db: Database,
  minAccess: number,
  minConfidence: number,
  limit: number,
): ArchiveRow[] {
  return db
    .query<ArchiveRow, [number, number, number]>(
      "SELECT * FROM layer3_archive WHERE access_count >= ? AND confidence IS NOT NULL AND confidence >= ? ORDER BY access_count DESC, updated_at DESC LIMIT ?",
    )
    .all(minAccess, minConfidence, limit);
}
