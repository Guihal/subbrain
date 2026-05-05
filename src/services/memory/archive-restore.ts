/**
 * PR-B: restoreFromArchive — moves a janitor-archived row back to its
 * original layer (shared_memory or layer2_context). Layer is encoded in
 * archive tags as "original_layer:shared" or "original_layer:context".
 * Shared rows additionally encode "original_category:<cat>" so the row
 * can be restored with a WHITELIST_SHARED-compliant category (otherwise
 * the next JANITOR_LEGACY_SWEEP=true pass would re-archive it). Falls
 * back to "preference" only when the tag is missing.
 * Operation is atomic via db.transaction().
 */
import { randomUUID } from "node:crypto";
import type { ArchiveRow, MemoryDB } from "@subbrain/core/db";

export interface RestoreResult {
  archiveId: string;
  restoredId: string;
  restoredLayer: "shared" | "context";
}

/** Parse "original_layer:shared" or "original_layer:context" from tags CSV. */
function parseOriginalLayer(tags: string): "shared" | "context" | null {
  const m = tags.match(/original_layer:(shared|context)/);
  return m ? (m[1] as "shared" | "context") : null;
}

/**
 * Parse "original_category:<cat>" from tags CSV. Stops at next comma so a
 * trailing CSV segment doesn't get folded in. Returns null when missing.
 */
function parseOriginalCategory(tags: string): string | null {
  const m = tags.match(/original_category:([^,]+)/);
  return m ? m[1].trim() : null;
}

export function restoreFromArchive(
  memory: MemoryDB,
  archiveId: string,
  row: ArchiveRow,
): RestoreResult {
  const layer = parseOriginalLayer(row.tags);
  if (!layer) {
    throw new Error(`archive row ${archiveId} has no original_layer tag — cannot restore`);
  }

  const restoredId = randomUUID();
  // For shared layer, restore the original (whitelist-safe) category. Fall
  // back to "preference" — a known WHITELIST_SHARED member — when the tag
  // is absent (legacy archives written before original_category encoding).
  const restoredCategory = parseOriginalCategory(row.tags) ?? "preference";

  memory.transaction(() => {
    if (layer === "shared") {
      memory.insertShared(restoredId, restoredCategory, row.content, row.tags, "restore");
    } else {
      memory.insertContext(restoredId, row.title, row.content, row.tags);
    }
    memory.deleteArchive(archiveId);
  });

  return { archiveId, restoredId, restoredLayer: layer };
}
