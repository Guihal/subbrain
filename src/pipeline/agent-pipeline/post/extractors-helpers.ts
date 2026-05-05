/**
 * MEM-6: shared helpers for `writeShared` / `writeContext` in extractors.ts.
 *
 * Split out to keep extractors.ts under the 250-LOC file cap (per
 * subbrain-guardrails §1). Pure helpers + supersede validation/apply.
 */
import type { ContextRow, MemoryDB, MemoryStatus, SharedRow } from "../../../db";
import type { RAGPipeline } from "../../../rag";

export const EMBED_TIMEOUT_MS = 5000;
export const MAX_SUPERSEDES = 10;

export function computeStatus(confidence: number): "active" | "pending" {
  const threshold = Number(process.env.MEMORY_AUTOACCEPT_CONFIDENCE ?? 0.8);
  const clamped = Math.min(1, Math.max(0, confidence));
  return clamped >= threshold ? "active" : "pending";
}

export type SupersedeCheck =
  | { ok: true; rows: (SharedRow | ContextRow)[] }
  | { ok: false; reason: string };

/**
 * Validate `supersedes` ids: cap, exists, same layer, not already
 * superseded. Pure read — caller wraps writes in their own transaction.
 */
export function validateSupersedes(
  memory: MemoryDB,
  layer: "shared" | "context",
  ids: string[],
): SupersedeCheck {
  if (ids.length > MAX_SUPERSEDES) {
    return { ok: false, reason: `supersedes too large (${ids.length} > ${MAX_SUPERSEDES})` };
  }
  const rows: (SharedRow | ContextRow)[] = [];
  for (const id of ids) {
    if (typeof id !== "string" || id.length === 0) {
      return { ok: false, reason: `supersedes contains invalid id` };
    }
    const row = layer === "shared" ? memory.getShared(id) : memory.getContext(id);
    if (!row) {
      return { ok: false, reason: `supersedes id '${id}' not found in ${layer}` };
    }
    if (row.superseded_by !== null) {
      return {
        ok: false,
        reason: `supersedes id '${id}' already superseded by '${row.superseded_by}'`,
      };
    }
    rows.push(row);
  }
  return { ok: true, rows };
}

/**
 * Mark each `oldIds` row as superseded by `newId`. Caller MUST be inside
 * a transaction (this is invoked from within `memory.transaction(...)` in
 * extractors.ts to keep insert + supersede atomic).
 */
export function applySupersedes(
  memory: MemoryDB,
  layer: "shared" | "context",
  newId: string,
  oldIds: string[],
): void {
  if (layer === "shared") {
    for (const oldId of oldIds) {
      memory.updateShared(oldId, { superseded_by: newId });
    }
  } else {
    for (const oldId of oldIds) {
      memory.updateContext(oldId, { superseded_by: newId });
    }
  }
}

/**
 * Embed `content` if `existing` is null. Returns the vec or null on failure
 * (caller surfaces error). Used to reuse a vec already computed by the dedupe
 * pass instead of paying for a second embed.
 */
export async function embedOrReuse(
  rag: RAGPipeline,
  content: string,
  existing: Float32Array | null,
): Promise<Float32Array | null> {
  if (existing && existing.length > 0) return existing;
  try {
    const vec = await rag.embedContent(content, AbortSignal.timeout(EMBED_TIMEOUT_MS));
    if (!vec || vec.length === 0) return null;
    return vec;
  } catch {
    return null;
  }
}

export interface WriteResult {
  ok: boolean;
  id?: string;
  error?: string;
  status?: MemoryStatus;
  /** True when the call updated a duplicate instead of inserting. */
  merged?: boolean;
}
