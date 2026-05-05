import type { MemoryDB } from "../../db";
import { linkRelated, parseTagsCsv } from "../../pipeline/agent-pipeline/post/link-related";
import type { RAGPipeline } from "../../rag";
import type { MemoryServiceLinkDeps } from "./types";

/**
 * M-13: best-effort post-hook calling `linkRelated` after a successful
 * embed-first transactional insert. Skipped when either `memoryDb` or
 * `linkDeps` is unset (test/script paths). Any throw is swallowed and logged
 * — the row + embedding stay committed.
 */
export async function runLinkRelated(
  memoryDb: MemoryDB | null,
  rag: RAGPipeline,
  linkDeps: MemoryServiceLinkDeps | null,
  id: string,
  layer: "shared" | "context",
  content: string,
  tagsCsv: string,
): Promise<void> {
  if (!linkDeps || !memoryDb) return;
  try {
    await linkRelated(
      memoryDb,
      rag,
      linkDeps.router,
      id,
      layer,
      content,
      parseTagsCsv(tagsCsv),
      linkDeps.log,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    linkDeps.log.warn("memory.svc", `linkRelated failed for ${id}: ${msg}`);
  }
}
