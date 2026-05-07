/** Supersede path: embed + insert + link + rollback on failure. */

import { logger } from "@subbrain/core/lib/logger";
import type { MemoryKind } from "@subbrain/core/db";
import type { RAGPipeline } from "../../../../rag";
import type { MemoryService } from "../../../../services/memory";
import type { ToolResult } from "../../../types";
import { embedWithTimeout } from "../types";
import { embedThenInsertTxn, insertViaService } from "./insert";
import { SharedWriteErr, buildError } from "./validators";
import type { SharedWriteDeps, SharedWriteParams } from "./index";

const log = logger.child("memory.write-shared");

function rollbackOrphan(newId: string, supersedesId: string, err: unknown): void {
  log.warn("supersede_rollback_failed: orphan row remains", {
    meta: { newId, supersedesId, error: String(err) },
  });
}

export async function insertAndSupersede(
  deps: SharedWriteDeps,
  svc: MemoryService | null,
  rag: RAGPipeline | null,
  params: SharedWriteParams,
  kind: MemoryKind,
  expiresAt: number | null,
  supersedesId: string,
  signal?: AbortSignal,
): Promise<string | ToolResult> {
  if (svc) {
    let newId: string;
    try {
      newId = await insertViaService(svc, params, kind, expiresAt);
    } catch (e) {
      return buildError(SharedWriteErr.INSERT_FAILED, e);
    }
    try {
      deps.memory.transaction(() => {
        deps.memory.updateShared(supersedesId, { superseded_by: newId });
      });
    } catch (e) {
      log.warn("supersede_link_failed: " + String(e), { meta: { newId, supersedesId } });
      try {
        deps.memory.transaction(() => deps.memory.deleteShared(newId));
      } catch (re) {
        rollbackOrphan(newId, supersedesId, re);
      }
      return buildError(SharedWriteErr.SUPERSEDE_LINK_FAILED, e);
    }
    return newId;
  }

  // svc branch above; rag must be present here (guarded by caller).
  let vec: Float32Array;
  try {
    vec = await embedWithTimeout(rag!, params.content, signal);
  } catch (e) {
    return buildError(SharedWriteErr.EMBED_FAILED, e);
  }
  if (!vec || vec.length === 0) return buildError(SharedWriteErr.EMBED_EMPTY, "embed returned empty vector");

  return embedThenInsertTxn(deps, params, kind, expiresAt, vec, supersedesId);
}
