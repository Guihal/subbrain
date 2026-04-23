/**
 * Atomic memory writers used by the post-processing hippocampus.
 *
 * writeContext uses an embed-first strategy:
 *   1. Await rag.embedContent(content) (with 5s timeout) BEFORE any DB call.
 *   2. Inside a sync bun:sqlite transaction, insert the row + upsert the
 *      vec_embedding. The network call never enters the transaction, and a
 *      failure at any step leaves the DB unchanged (no row-without-embed
 *      window; no orphan vec).
 *
 * Known follow-up: rag.embedContent does not accept an AbortSignal, so a
 * timed-out embed keeps running in the background until the http-client's
 * default timeout fires. That is a resource-leak, not a correctness bug —
 * a later PR will thread AbortSignal through ModelRouter.scheduleRaw.
 */
import { randomUUID } from "crypto";
import type { MemoryDB } from "../../../db";
import type { RAGPipeline } from "../../../rag";
import type { RequestLogger } from "../../../lib/logger";

const EMBED_TIMEOUT_MS = 5000;

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

export async function writeContext(
  memory: MemoryDB,
  rag: RAGPipeline,
  args: { category: string; content: string; tags: string },
  requestId: string,
  log: RequestLogger,
): Promise<WriteResult> {
  const id = randomUUID();

  let vec: Float32Array;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    vec = await Promise.race([
      rag.embedContent(args.content),
      new Promise<never>((_, rej) => {
        timer = setTimeout(
          () => rej(new Error("embed_timeout")),
          EMBED_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (err) {
    if (timer) clearTimeout(timer);
    const em = err instanceof Error ? err.message : String(err);
    log.warn("post", `writeContext embed failed: ${em}`);
    return { ok: false, error: em };
  }
  if (timer) clearTimeout(timer);

  if (!vec || vec.length === 0) {
    log.warn("post", "writeContext embed returned empty vector");
    return { ok: false, error: "embed_empty" };
  }

  try {
    memory.db.transaction(() => {
      memory.insertContext(id, args.category, args.content, args.tags, [requestId]);
      memory.upsertEmbedding(id, "context", vec);
    })();
  } catch (err) {
    const em = err instanceof Error ? err.message : String(err);
    log.error("post", `writeContext transaction failed: ${em}`);
    return { ok: false, error: em };
  }

  log.info(
    "post",
    `→ context/${args.category}: ${args.content.slice(0, 100)}`,
    { meta: { factId: id, layer: "context", category: args.category } },
  );
  return { ok: true, id };
}
