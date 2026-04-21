/**
 * Atomic memory writers used by the post-processing hippocampus.
 * Split from hippocampus.ts so they can be tested + reused independently.
 */
import { randomUUID } from "crypto";
import type { MemoryDB } from "../../../db";
import type { RAGPipeline } from "../../../rag";
import type { RequestLogger } from "../../../lib/logger";

export interface WriteResult {
  ok: boolean;
  id?: string;
  error?: string;
}

export function writeShared(
  memory: MemoryDB,
  args: { category: string; content: string; tags: string },
  log: RequestLogger,
): WriteResult {
  const id = randomUUID();
  try {
    memory.insertShared(id, args.category, args.content, args.tags, "post-processing");
    log.info(
      "post",
      `→ shared/${args.category}: ${args.content.slice(0, 100)}`,
      { meta: { factId: id, layer: "shared", category: args.category } },
    );
    return { ok: true, id };
  } catch (err) {
    const em = err instanceof Error ? err.message : String(err);
    log.warn("post", `memory_write shared failed: ${em}`);
    return { ok: false, error: em };
  }
}

export function writeContext(
  memory: MemoryDB,
  rag: RAGPipeline,
  args: { category: string; content: string; tags: string },
  requestId: string,
  log: RequestLogger,
): WriteResult {
  const id = randomUUID();
  try {
    memory.insertContext(id, args.category, args.content, args.tags, [requestId]);
    rag.indexEntry(id, "context", args.content).catch(() => {});
    log.info(
      "post",
      `→ context/${args.category}: ${args.content.slice(0, 100)}`,
      { meta: { factId: id, layer: "context", category: args.category } },
    );
    return { ok: true, id };
  } catch (err) {
    const em = err instanceof Error ? err.message : String(err);
    log.warn("post", `memory_write context failed: ${em}`);
    return { ok: false, error: em };
  }
}
