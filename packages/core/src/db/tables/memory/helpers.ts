import type { MemoryStatus } from "../../types";

// columns updatable from REST/UI
// MEM-5 (PR 22a): status joins the allow-list so the approval UI (PR 22b)
// can transition pending → active/rejected via updateContext.
// MEM-6 (mig 9): expires_at + superseded_by join the allow-list — same
// rationale as shared_memory (post-hippocampus + night-cycle write paths).
export const CONTEXT_UPDATABLE = new Set([
  "title",
  "content",
  "tags",
  "status",
  "confidence",
  "expires_at",
  "superseded_by",
  "derived_from",
  "valid_from",
  "valid_to",
  "observed_at",
]);
export const ARCHIVE_UPDATABLE = new Set(["title", "content", "tags", "confidence"]);

// MEM-6: same shape as shared.ts:buildActiveFilter — kept here so each table
// file owns its own SQL (boundary test forbids services hitting SQL directly,
// but tables/* are the system-of-record).
export function buildActiveFilter(
  alias: string,
  opts: { activeOnly?: boolean; notStale?: boolean } | undefined,
): string {
  const parts: string[] = [];
  if (opts?.activeOnly) parts.push(`AND ${alias}.status = 'active'`);
  if (opts?.notStale) {
    parts.push(`AND ${alias}.superseded_by IS NULL`);
    parts.push(`AND (${alias}.expires_at IS NULL OR ${alias}.expires_at > unixepoch())`);
  }
  // P3-3: bi-temporal active filter — exact SQL:
  // AND (valid_from IS NULL OR valid_from <= unixepoch()) AND (valid_to IS NULL OR valid_to > unixepoch())
  if (opts?.activeOnly) {
    parts.push(
      `AND (${alias}.valid_from IS NULL OR ${alias}.valid_from <= unixepoch()) AND (${alias}.valid_to IS NULL OR ${alias}.valid_to > unixepoch())`,
    );
  }
  return parts.length === 0 ? "" : ` ${parts.join(" ")}`;
}

export interface InsertContextOpts {
  confidence?: number | null;
  status?: MemoryStatus;
  // PR-A: differential TTL defaults by category.
  expires_at?: number | null;
  // P3-2 (mig 17): bi-temporal columns on insert.
  valid_from?: number | null;
  valid_to?: number | null;
  observed_at?: number | null;
}
