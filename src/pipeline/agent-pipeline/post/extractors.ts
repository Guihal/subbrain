/**
 * Atomic memory writers used by the post-processing hippocampus.
 *
 * writeShared and writeContext use an embed-first strategy:
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
import type { MemoryDB, MemoryStatus } from "../../../db";
import type { RAGPipeline } from "../../../rag";
import type { RequestLogger } from "../../../lib/logger";

const EMBED_TIMEOUT_MS = 5000;

export interface WriteResult {
  ok: boolean;
  id?: string;
  error?: string;
  status?: MemoryStatus;
}

/**
 * MEM-5 (PR 22a): compute memory status from a 0..1 confidence score and the
 * MEMORY_AUTOACCEPT_CONFIDENCE threshold (default 0.8). Below threshold →
 * 'pending', requires human approval before RAG injection picks it up.
 */
function computeStatus(confidence: number): "active" | "pending" {
  const threshold = Number(process.env.MEMORY_AUTOACCEPT_CONFIDENCE ?? 0.8);
  const clamped = Math.min(1, Math.max(0, confidence));
  return clamped >= threshold ? "active" : "pending";
}

async function embedWithTimeout(
  rag: RAGPipeline,
  content: string,
): Promise<Float32Array> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      rag.embedContent(content),
      new Promise<never>((_, rej) => {
        timer = setTimeout(
          () => rej(new Error("embed_timeout")),
          EMBED_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function writeShared(
  memory: MemoryDB,
  rag: RAGPipeline,
  args: { category: string; content: string; tags: string; confidence: number },
  log: RequestLogger,
): Promise<WriteResult> {
  const id = randomUUID();
  const status = computeStatus(args.confidence);
  const clamped = Math.min(1, Math.max(0, args.confidence));

  let vec: Float32Array;
  try {
    vec = await embedWithTimeout(rag, args.content);
  } catch (err) {
    const em = err instanceof Error ? err.message : String(err);
    log.warn("post", `writeShared embed failed: ${em}`);
    return { ok: false, error: em };
  }

  if (!vec || vec.length === 0) {
    log.warn("post", "writeShared embed returned empty vector");
    return { ok: false, error: "embed_empty" };
  }

  try {
    memory.db.transaction(() => {
      memory.insertShared(
        id,
        args.category,
        args.content,
        args.tags,
        "post-processing",
        { confidence: clamped, status },
      );
      memory.upsertEmbedding(id, "shared", vec);
    })();
  } catch (err) {
    const em = err instanceof Error ? err.message : String(err);
    log.error("post", `writeShared transaction failed: ${em}`);
    return { ok: false, error: em };
  }

  log.info(
    "post",
    `→ shared/${args.category} [${status} ${clamped.toFixed(2)}]: ${args.content.slice(0, 100)}`,
    { meta: { factId: id, layer: "shared", category: args.category, status, confidence: clamped } },
  );
  return { ok: true, id, status };
}

export async function writeContext(
  memory: MemoryDB,
  rag: RAGPipeline,
  args: { category: string; content: string; tags: string; confidence: number },
  requestId: string,
  log: RequestLogger,
): Promise<WriteResult> {
  const id = randomUUID();
  const status = computeStatus(args.confidence);
  const clamped = Math.min(1, Math.max(0, args.confidence));

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
      memory.insertContext(
        id,
        args.category,
        args.content,
        args.tags,
        [requestId],
        undefined,
        { confidence: clamped, status },
      );
      memory.upsertEmbedding(id, "context", vec);
    })();
  } catch (err) {
    const em = err instanceof Error ? err.message : String(err);
    log.error("post", `writeContext transaction failed: ${em}`);
    return { ok: false, error: em };
  }

  log.info(
    "post",
    `→ context/${args.category} [${status} ${clamped.toFixed(2)}]: ${args.content.slice(0, 100)}`,
    { meta: { factId: id, layer: "context", category: args.category, status, confidence: clamped } },
  );
  return { ok: true, id, status };
}
