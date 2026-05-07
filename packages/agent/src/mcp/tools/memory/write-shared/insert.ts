/** Insert helpers: service path + embed-then-transaction path. */

import type { MemoryKind } from "@subbrain/core/db";
import type { RAGPipeline } from "../../../../rag";
import type { MemoryService } from "../../../../services/memory";
import type { ToolResult } from "../../../types";
import { embedWithTimeout } from "../types";
import type { SharedWriteDeps, SharedWriteParams } from "./index";
import { buildError, SharedWriteErr } from "./validators";

export async function insertViaService(
  svc: MemoryService,
  params: SharedWriteParams,
  kind: MemoryKind,
  expiresAt: number | null,
): Promise<string> {
  return svc.insertShared({
    category: params.category,
    content: params.content,
    tags: params.tags,
    confidence: params.confidence,
    status: params.status,
    kind,
    expires_at: expiresAt,
  });
}

export async function embedThenInsertTxn(
  deps: SharedWriteDeps,
  params: SharedWriteParams,
  kind: MemoryKind,
  expiresAt: number | null,
  vec: Float32Array,
  supersedesId?: string,
): Promise<string | ToolResult> {
  try {
    deps.memory.transaction(() => {
      deps.memory.insertShared(params.id, params.category, params.content, params.tags, undefined, {
        confidence: params.confidence,
        status: params.status,
        kind,
        expires_at: expiresAt,
      });
      deps.memory.upsertEmbedding(params.id, "shared", vec);
      if (supersedesId) deps.memory.updateShared(supersedesId, { superseded_by: params.id });
    });
  } catch (e) {
    return buildError(SharedWriteErr.TXN_FAILED, e);
  }
  return params.id;
}

export async function doInsert(
  deps: SharedWriteDeps,
  svc: MemoryService | null,
  rag: RAGPipeline | null,
  params: SharedWriteParams,
  kind: MemoryKind,
  expiresAt: number | null,
  signal?: AbortSignal,
): Promise<string | ToolResult> {
  if (svc) {
    try {
      return await insertViaService(svc, params, kind, expiresAt);
    } catch (e) {
      return buildError(SharedWriteErr.INSERT_FAILED, e);
    }
  }
  if (!rag) return buildError(SharedWriteErr.NO_INSERT_PATH, "no rag or svc");

  let vec: Float32Array;
  try {
    vec = await embedWithTimeout(rag, params.content, signal);
  } catch (e) {
    return buildError(SharedWriteErr.EMBED_FAILED, e);
  }
  if (!vec || vec.length === 0)
    return buildError(SharedWriteErr.EMBED_EMPTY, "embed returned empty vector");

  return embedThenInsertTxn(deps, params, kind, expiresAt, vec);
}
