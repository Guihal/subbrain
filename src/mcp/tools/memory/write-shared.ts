/**
 * Shared-layer write path. M-FINAL2 + MEM-2 (M-01) + M-07.1.
 *
 * Two paths:
 *   1. Preferred: an injected `MemoryService` is the single source of
 *      embed-first + transactional shared writes (mirrors
 *      `extractors.writeShared`). Service mints its own id.
 *   2. Legacy fallback: `writeSharedAtomic` keeps the same atomicity
 *      guarantee for older tests that construct `MemoryTools` without
 *      wiring a service.
 *
 * Final fallback: caller did not wire a RAG pipeline (older tests, boot
 * scripts). Sync raw insert; row will lack vec_embeddings until a
 * follow-up indexEntry runs. Acceptable only outside prod.
 */
import type { MemoryDB, MemoryKind } from "../../../db";
import type { RAGPipeline } from "../../../rag";
import type { MemoryService } from "../../../services/memory.service";
import type { ToolResult } from "../../types";
import { categoryToKind } from "../../../pipeline/agent-pipeline/post/validators";
import { embedWithTimeout } from "./types";

export interface SharedWriteParams {
  id: string;
  category: string;
  content: string;
  tags: string;
  confidence: number;
  status: "active" | "pending";
}

export function writeShared(
  deps: {
    memory: MemoryDB;
    getRag: () => RAGPipeline | null;
    memoryService: MemoryService | null;
  },
  params: SharedWriteParams,
): ToolResult | Promise<ToolResult> {
  // M-07.1: derive kind ONCE here so both paths (service delegate +
  // legacy fallback + raw-insert path with no RAG) use the same
  // classification. Persona-grade categories (profile/preference/
  // relationship) → 'persona', everything else → 'semantic'.
  const kind = categoryToKind(params.category, "shared");

  // M-FINAL2: prefer the injected service so we don't fork the
  // embed-first + transactional logic. The service generates its own
  // id and returns it — we ignore the caller's id in this path. (The
  // public registry path already lets MemoryTools mint the id; legacy
  // direct callers pass id explicitly and hit the writeSharedAtomic
  // fallback below where the caller-supplied id is honoured.)
  const svc = deps.memoryService;
  if (svc) {
    return svc
      .insertShared({
        category: params.category,
        content: params.content,
        tags: params.tags,
        confidence: params.confidence,
        status: params.status,
        kind,
      })
      .then(
        (newId): ToolResult => ({ success: true, data: { id: newId } }),
        (err): ToolResult => ({
          success: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
  }
  const rag = deps.getRag();
  if (rag) {
    // Legacy fallback (no service wired): atomic embed+insert. Returns
    // a Promise so the caller awaits the upstream embed call. Skips the
    // caller's fire-and-forget indexEntry — the transaction already
    // wrote vec_embeddings.
    return writeSharedAtomic(deps.memory, { ...params, kind }, rag);
  }
  // Final fallback: caller did not wire a RAG pipeline. Sync raw insert;
  // row will lack vec_embeddings until a follow-up indexEntry runs.
  deps.memory.insertShared(
    params.id,
    params.category,
    params.content,
    params.tags,
    undefined,
    { confidence: params.confidence, status: params.status, kind },
  );
  return { success: true, data: { id: params.id } };
}

/**
 * MEM-2 (M-01) / M-FINAL2: legacy fallback path for the `shared` layer
 * when no `MemoryService` was wired (older tests). Mirrors
 * `MemoryService.insertShared` (embed-first + transactional). Production
 * goes through the injected service via `setMemoryService`.
 */
async function writeSharedAtomic(
  memory: MemoryDB,
  params: SharedWriteParams & { kind: MemoryKind },
  rag: RAGPipeline,
): Promise<ToolResult> {
  let vec: Float32Array;
  try {
    vec = await embedWithTimeout(rag, params.content);
  } catch (err) {
    return {
      success: false,
      error: `embed_failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!vec || vec.length === 0) {
    return { success: false, error: "embed_empty" };
  }
  try {
    memory.transaction(() => {
      memory.insertShared(
        params.id,
        params.category,
        params.content,
        params.tags,
        undefined,
        {
          confidence: params.confidence,
          status: params.status,
          kind: params.kind,
        },
      );
      memory.upsertEmbedding(params.id, "shared", vec);
    });
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  return { success: true, data: { id: params.id } };
}
