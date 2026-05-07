/** Shared-layer write facade. PR-A: validate + dedup (strict/supersede) + MEMORY_VALIDATORS_ENFORCE. */

import type { MemoryDB, MemoryKind } from "@subbrain/core/db";
import { logger } from "@subbrain/core/lib/logger";
import {
  categoryToKind,
  defaultExpiresAt,
  validateCategoryAndContent,
  validateExpiresAt,
} from "../../../../pipeline/agent-pipeline/post/validators";
import type { RAGPipeline } from "../../../../rag";
import type { MemoryService } from "../../../../services/memory";
import { checkDuplicate } from "../../../../services/memory";
import type { ToolResult } from "../../../types";
import { doInsert } from "./insert";
import { insertAndSupersede } from "./supersede";
import { maybeReject } from "./validators";

const log = logger.child("memory.write-shared");

export interface SharedWriteParams {
  id: string;
  category: string;
  content: string;
  tags: string;
  confidence: number;
  status: "active" | "pending";
  expires_at?: number | null;
}

export interface SharedWriteDeps {
  memory: MemoryDB;
  getRag: () => RAGPipeline | null;
  memoryService: MemoryService | null;
}

export function writeShared(
  deps: SharedWriteDeps,
  params: SharedWriteParams,
  signal?: AbortSignal,
): ToolResult | Promise<ToolResult> {
  const kind = categoryToKind(params.category, "shared");

  const catR = validateCategoryAndContent("shared", params.category, params.content);
  if (!catR.ok) {
    const r = maybeReject(catR.reason, { category: params.category, layer: "shared" });
    if (r) return r;
  }

  const expiresAt =
    typeof params.expires_at === "number"
      ? params.expires_at
      : defaultExpiresAt("shared", params.category);
  const expR = validateExpiresAt(params.category, expiresAt);
  if (!expR.ok) {
    const r = maybeReject(expR.reason, { category: params.category });
    if (r) return r;
  }

  const rag = deps.getRag();
  const svc = deps.memoryService;
  if (svc || rag) return writeWithDedupAsync(deps, svc, rag, params, kind, expiresAt, signal);

  // Final fallback: no service, no rag — raw sync insert.
  deps.memory.insertShared(params.id, params.category, params.content, params.tags, undefined, {
    confidence: params.confidence,
    status: params.status,
    kind,
    expires_at: expiresAt,
  });
  return { success: true, data: { id: params.id } };
}

async function writeWithDedupAsync(
  deps: SharedWriteDeps,
  svc: MemoryService | null,
  rag: RAGPipeline | null,
  params: SharedWriteParams,
  kind: MemoryKind,
  expiresAt: number | null,
  signal?: AbortSignal,
): Promise<ToolResult> {
  if (rag) {
    try {
      const dd = await checkDuplicate(deps.memory, rag, "shared", params.category, params.content);
      if (dd.action === "reject") {
        const r = maybeReject(`duplicate (cosine=${dd.similarity?.toFixed(3)})`, {
          category: params.category,
        });
        if (r) return r;
      } else if (dd.action === "supersede" && dd.supersedesId) {
        const newId = await insertAndSupersede(
          deps,
          svc,
          rag,
          params,
          kind,
          expiresAt,
          dd.supersedesId,
          signal,
        );
        if (typeof newId === "object") return newId;
        return { success: true, data: { id: newId, superseded: dd.supersedesId } };
      }
    } catch (e) {
      log.warn(`dedup_error: ${String(e)}`);
    }
  }
  const result = await doInsert(deps, svc, rag, params, kind, expiresAt, signal);
  if (typeof result === "object") return result;
  return { success: true, data: { id: result } };
}
