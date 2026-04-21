import type { Database, SQLQueryBindings } from "bun:sqlite";

/**
 * Generic UPDATE helper with column allowlist. Always bumps `updated_at`.
 * No-ops if `patch` has no allowed keys. Assumes PK column is `id`.
 */
export function updateRow(
  db: Database,
  table: string,
  allow: Set<string>,
  id: string | number,
  patch: Record<string, unknown>,
): void {
  const sets: string[] = ["updated_at = unixepoch()"];
  const vals: SQLQueryBindings[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (!allow.has(k)) continue;
    sets.push(`${k} = ?`);
    vals.push(v as SQLQueryBindings);
  }
  if (sets.length === 1) return;
  vals.push(id as SQLQueryBindings);
  db.query(`UPDATE ${table} SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
}
