import type { MemoryKind, MemoryStatus } from "../../types";

// columns updatable from REST/UI
// MEM-5 (PR 22a): status joins the allow-list so the upcoming approval UI
// (PR 22b) can transition pending → active/rejected via updateShared.
// MEM-6 (mig 9): expires_at + superseded_by join the allow-list so the
// post-hippocampus + night cycle can write expiry/supersede markers via
// the same `updateRow` path the admin UI uses.
// M-07 (mig 12): `kind` joins so the post-hippocampus extractor can write
// the persona/semantic classification on a merge-update of an existing row.
// Trigger `trg_shared_kind_check_upd` enforces the closed enum at SQL level.
export const SHARED_UPDATABLE = new Set([
  "content",
  "tags",
  "category",
  "status",
  "confidence",
  "expires_at",
  "superseded_by",
  "kind",
  "valid_from",
  "valid_to",
  "observed_at",
]);
export const AGENT_MEM_UPDATABLE = new Set(["content", "tags"]);

// MEM-6: shared SQL fragment used by every read path that filters out
// expired/superseded rows. Lives here so the SQL stays in `tables/*` (per
// `tests/layer-boundary.test.ts`); call sites compose by string concat.
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

export interface InsertSharedOpts {
  confidence?: number | null;
  status?: MemoryStatus;
  // M-07 (mig 12): persona/semantic/episodic/procedural. Default 'semantic'
  // matches the SQL DEFAULT — callers pass 'persona' for identity facts via
  // `categoryToKind(category, 'shared')` in the post-hippocampus.
  kind?: MemoryKind;
  // PR-A: differential TTL defaults by category.
  expires_at?: number | null;
  // P3-2 (mig 17): bi-temporal columns on insert.
  valid_from?: number | null;
  valid_to?: number | null;
  observed_at?: number | null;
}
