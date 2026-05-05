/** Shared-layer write. PR-A: validate + dedup (strict/supersede) + MEMORY_VALIDATORS_ENFORCE. */

import type { MemoryDB, MemoryKind } from "../../../db";
import { logger } from "../../../lib/logger";
import { incrementCounter } from "../../../lib/metrics";
import {
  categoryToKind,
  defaultExpiresAt,
  validateCategoryAndContent,
  validateExpiresAt,
} from "../../../pipeline/agent-pipeline/post/validators";
import type { RAGPipeline } from "../../../rag";
import type { MemoryService } from "../../../services/memory";
import { checkDuplicate } from "../../../services/memory";
import type { ToolResult } from "../../types";
import { embedWithTimeout } from "./types";

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

function mode(): "warn" | "reject" {
  return process.env.MEMORY_VALIDATORS_ENFORCE === "reject" ? "reject" : "warn";
}

function maybeReject(reason: string, ctx: Record<string, unknown>): ToolResult | null {
  const m = mode();
  incrementCounter("memory_write_validator_triggered_total", { enforce_mode: m });
  if (m === "reject")
    return { success: false, error: { code: "validation_failed", message: reason } };
  log.warn(`would_reject: ${reason}`, { meta: ctx });
  return null;
}

export function writeShared(
  deps: SharedWriteDeps,
  params: SharedWriteParams,
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
  if (svc || rag) return writeWithDedupAsync(deps, svc, rag, params, kind, expiresAt);
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
        // Embed first (async/remote); then insert+supersede-update in one DB transaction.
        const newId = await insertAndSupersede(
          deps,
          svc,
          rag,
          params,
          kind,
          expiresAt,
          dd.supersedesId,
        );
        if (typeof newId === "object") return newId;
        return { success: true, data: { id: newId, superseded: dd.supersedesId } };
      }
    } catch (e) {
      log.warn(`dedup_error: ${String(e)}`);
    }
  }
  const result = await doInsert(deps, svc, rag, params, kind, expiresAt);
  if (typeof result === "object") return result;
  return { success: true, data: { id: result } };
}
/** Embed (async), then single transaction: insert new row + mark old row superseded. */
async function insertAndSupersede(
  deps: SharedWriteDeps,
  svc: MemoryService | null,
  rag: RAGPipeline | null,
  params: SharedWriteParams,
  kind: MemoryKind,
  expiresAt: number | null,
  supersedesId: string,
): Promise<string | ToolResult> {
  if (svc) {
    let newId: string;
    try {
      newId = await svc.insertShared({
        category: params.category,
        content: params.content,
        tags: params.tags,
        confidence: params.confidence,
        status: params.status,
        kind,
        expires_at: expiresAt,
      });
    } catch (e) {
      return {
        success: false,
        error: { code: "insert_failed", message: e instanceof Error ? e.message : String(e) },
      };
    }
    try {
      deps.memory.transaction(() => {
        deps.memory.updateShared(supersedesId, { superseded_by: newId });
      });
    } catch (e) {
      log.warn("supersede_link_failed", { meta: { newId, supersedesId, error: String(e) } });
      try {
        deps.memory.transaction(() => {
          deps.memory.deleteShared(newId);
        });
      } catch (re) {
        log.warn("supersede_rollback_failed: orphan row remains", {
          meta: { newId, error: String(re) },
        });
      }
      return {
        success: false,
        error: {
          code: "supersede_link_failed",
          message: e instanceof Error ? e.message : String(e),
        },
      };
    }
    return newId;
  }
  if (!rag) return { success: false, error: { code: "no_insert_path", message: "no rag or svc" } };
  // Pre-compute embed (async) outside transaction, then insert+link atomically.
  let vec: Float32Array;
  try {
    vec = await embedWithTimeout(rag, params.content);
  } catch (e) {
    return {
      success: false,
      error: { code: "embed_failed", message: e instanceof Error ? e.message : String(e) },
    };
  }
  if (!vec || vec.length === 0)
    return {
      success: false,
      error: { code: "embed_empty", message: "embed returned empty vector" },
    };
  try {
    deps.memory.transaction(() => {
      deps.memory.insertShared(params.id, params.category, params.content, params.tags, undefined, {
        confidence: params.confidence,
        status: params.status,
        kind,
        expires_at: expiresAt,
      });
      deps.memory.upsertEmbedding(params.id, "shared", vec);
      deps.memory.updateShared(supersedesId, { superseded_by: params.id });
    });
  } catch (e) {
    return {
      success: false,
      error: { code: "txn_failed", message: e instanceof Error ? e.message : String(e) },
    };
  }
  return params.id;
}
/** Insert via service (preferred) or embed-atomic (legacy). Returns new id or ToolResult error. */
async function doInsert(
  deps: SharedWriteDeps,
  svc: MemoryService | null,
  rag: RAGPipeline | null,
  params: SharedWriteParams,
  kind: MemoryKind,
  expiresAt: number | null,
): Promise<string | ToolResult> {
  if (svc) {
    try {
      return await svc.insertShared({
        category: params.category,
        content: params.content,
        tags: params.tags,
        confidence: params.confidence,
        status: params.status,
        kind,
        expires_at: expiresAt,
      });
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  if (!rag) return { success: false, error: "no_insert_path" };
  let vec: Float32Array;
  try {
    vec = await embedWithTimeout(rag, params.content);
  } catch (e) {
    return { success: false, error: `embed_failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!vec || vec.length === 0) return { success: false, error: "embed_empty" };
  try {
    deps.memory.transaction(() => {
      deps.memory.insertShared(params.id, params.category, params.content, params.tags, undefined, {
        confidence: params.confidence,
        status: params.status,
        kind,
        expires_at: expiresAt,
      });
      deps.memory.upsertEmbedding(params.id, "shared", vec);
    });
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
  return params.id;
}
