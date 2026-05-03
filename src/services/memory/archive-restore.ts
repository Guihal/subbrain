/**
 * PR-B: restoreFromArchive — moves a janitor-archived row back to its
 * original layer (shared_memory or layer2_context). Layer is encoded in
 * archive tags as "original_layer:shared" or "original_layer:context".
 * Operation is atomic via db.transaction().
 */
import { randomUUID } from "crypto";
import type { ArchiveRow, MemoryDB } from "../../db";

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

export function restoreFromArchive(
  memory: MemoryDB,
  archiveId: string,
  row: ArchiveRow,
): RestoreResult {
  const layer = parseOriginalLayer(row.tags);
  if (!layer) {
    throw new Error(
      `archive row ${archiveId} has no original_layer tag — cannot restore`,
    );
  }

  const restoredId = randomUUID();

  memory.transaction(() => {
    if (layer === "shared") {
      memory.insertShared(restoredId, "restored", row.content, row.tags, "restore");
    } else {
      memory.insertContext(restoredId, row.title, row.content, row.tags);
    }
    memory.deleteArchive(archiveId);
  });

  return { archiveId, restoredId, restoredLayer: layer };
}
