import type { Database } from "bun:sqlite";

export function getFocus(db: Database, key: string): string | null {
  const row = db.query("SELECT value FROM layer1_focus WHERE key = ?").get(key) as {
    value: string;
  } | null;
  return row?.value ?? null;
}

/**
 * Same as getFocus but also returns updated_at (unix seconds). Used by the
 * tg_send_message focus-block gate to apply a 7-day TTL on the directive.
 * Empty / whitespace value should be treated as "cleared" by callers.
 */
export function getFocusWithMeta(
  db: Database,
  key: string,
): { value: string; updated_at: number } | null {
  const row = db.query("SELECT value, updated_at FROM layer1_focus WHERE key = ?").get(key) as {
    value: string;
    updated_at: number;
  } | null;
  return row ?? null;
}

export function setFocus(db: Database, key: string, value: string): void {
  db.query(
    "INSERT INTO layer1_focus (key, value, updated_at) VALUES (?, ?, unixepoch()) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).run(key, value);
}

export function getAllFocus(db: Database): Record<string, string> {
  const rows = db.query("SELECT key, value FROM layer1_focus").all() as {
    key: string;
    value: string;
  }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export function deleteFocus(db: Database, key: string): void {
  db.query("DELETE FROM layer1_focus WHERE key = ?").run(key);
}

// ─── Layer 1 shadow (M-11, mig 16) ─────────────────────────
// Mirror of layer1_focus written by the sleep-time rewriter night-cycle step.
// Real layer1_focus remains source-of-truth for system-prompt.ts; shadow
// exists so a human can diff proposed rewrites for weeks before any flip.
// Same KV shape, no FTS, no triggers.

export function getShadowFocus(db: Database, key: string): string | null {
  const row = db.query("SELECT value FROM layer1_focus_shadow WHERE key = ?").get(key) as {
    value: string;
  } | null;
  return row?.value ?? null;
}

export function setShadowFocus(db: Database, key: string, value: string): void {
  db.query(
    "INSERT INTO layer1_focus_shadow (key, value, updated_at) VALUES (?, ?, unixepoch()) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).run(key, value);
}

export function getAllShadowFocus(db: Database): Record<string, string> {
  const rows = db.query("SELECT key, value FROM layer1_focus_shadow").all() as {
    key: string;
    value: string;
  }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export function clearShadowFocus(db: Database): void {
  db.query("DELETE FROM layer1_focus_shadow").run();
}

/**
 * M-11: top-K shared_memory rows ranked for focus-block rewrite. persona kind
 * weighted ×1.5; salience baseline 0.5; access_count folded log-style so
 * very-popular rows pull but don't dominate. Filters to status='active'
 * (pending/rejected/superseded skipped). Used only by
 * `night-cycle/steps/focus-rewrite.ts`.
 */
export function selectTopSharedForFocusRewrite(
  db: Database,
  limit: number,
): {
  id: string;
  category: string;
  kind: string;
  content: string;
  salience: number | null;
  last_accessed_at: number | null;
  access_count: number;
}[] {
  return db
    .query<
      {
        id: string;
        category: string;
        kind: string;
        content: string;
        salience: number | null;
        last_accessed_at: number | null;
        access_count: number;
      },
      [number]
    >(
      `SELECT id, category, kind, content, salience, last_accessed_at, access_count
         FROM shared_memory
        WHERE status = 'active'
        ORDER BY (CASE WHEN kind='persona' THEN 1.5 ELSE 1.0 END)
               * (0.5 + COALESCE(salience, 0.5))
               * (1.0 + LOG(1 + COALESCE(access_count, 0)))
               DESC
        LIMIT ?`,
    )
    .all(limit);
}
