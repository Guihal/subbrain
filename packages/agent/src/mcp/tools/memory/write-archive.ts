import type { MemoryDB } from "@subbrain/core/db";
import type { WriteParams } from "./write";

/**
 * Archive-layer write. M-12 (mig 15): archive confidence is REAL [0..1]
 * — pass the already-clamped numeric value straight through. Archive is
 * shared-by-design (MEM-3); `agentId` is recorded for attribution only,
 * never used as a reader filter.
 */
export function writeArchiveCase(
  memory: MemoryDB,
  id: string,
  params: WriteParams,
  agentId: string | null,
  confidence: number,
): void {
  if (memory.getArchive(id)) {
    memory.updateArchive(id, {
      title: params.title,
      content: params.content,
      tags: params.tags,
      confidence,
    });
  } else {
    memory.insertArchive(
      id,
      params.title || "Untitled",
      params.content,
      params.tags || "",
      [],
      confidence,
      agentId ?? undefined,
    );
  }
}
