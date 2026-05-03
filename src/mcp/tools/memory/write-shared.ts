/**
 * Shared-layer write path. M-FINAL2 + MEM-2 (M-01) + M-07.1 + PR-A.
 *
 * PR-A enforcement (MEMORY_VALIDATORS_ENFORCE=warn|reject):
 *   1. validateCategoryAndContent + validateExpiresAt (whitelist + TIME_BOUND).
 *   2. defaultExpiresAt fills missing expires_at by category.
 *   3. checkDuplicate per-category dedup (strict/supersede modes).
 */
import { logger } from "../../../lib/logger";
import type { MemoryDB, MemoryKind } from "../../../db";
import type { RAGPipeline } from "../../../rag";
import type { MemoryService } from "../../../services/memory";
import type { ToolResult } from "../../types";
import {
  validateCategoryAndContent, validateExpiresAt,
  defaultExpiresAt, categoryToKind,
} from "../../../pipeline/agent-pipeline/post/validators";
import { checkDuplicate } from "../../../services/memory";
import { embedWithTimeout } from "./types";

const log = logger.child("memory.write-shared");

export interface SharedWriteParams {
  id: string; category: string; content: string;
  tags: string; confidence: number; status: "active" | "pending";
  expires_at?: number | null;
}

export interface SharedWriteDeps {
  memory: MemoryDB; getRag: () => RAGPipeline | null; memoryService: MemoryService | null;
}

function mode(): "warn" | "reject" {
  return process.env.MEMORY_VALIDATORS_ENFORCE === "reject" ? "reject" : "warn";
}

function maybeReject(reason: string, ctx: Record<string, unknown>): ToolResult | null {
  if (mode() === "reject")
    return { success: false, error: `validation_failed: ${reason}`, code: "validation_failed" } as ToolResult;
  log.warn(`would_reject: ${reason} ${JSON.stringify(ctx)}`);
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
  const expiresAt = typeof params.expires_at === "number" ? params.expires_at
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
  deps.memory.insertShared(params.id, params.category, params.content, params.tags, undefined,
    { confidence: params.confidence, status: params.status, kind, expires_at: expiresAt });
  return { success: true, data: { id: params.id } };
}

async function writeWithDedupAsync(
  deps: SharedWriteDeps, svc: MemoryService | null, rag: RAGPipeline | null,
  params: SharedWriteParams, kind: MemoryKind, expiresAt: number | null,
): Promise<ToolResult> {
  // PR-A dedup check (requires rag for embedding).
  if (rag) {
    try {
      const dd = await checkDuplicate(deps.memory, rag, "shared", params.category, params.content);
      if (dd.action === "reject") {
        const r = maybeReject(`duplicate (cosine=${dd.similarity?.toFixed(3)})`, { category: params.category });
        if (r) return r;
      } else if (dd.action === "supersede" && dd.supersedesId) {
        const newId = await doInsert(deps, svc, rag, params, kind, expiresAt);
        if (typeof newId === "object") return newId; // ToolResult error
        deps.memory.updateShared(dd.supersedesId, { superseded_by: newId, status: "active" });
        return { success: true, data: { id: newId, superseded: dd.supersedesId } };
      }
    } catch (e) { log.warn(`dedup_error: ${String(e)}`); }
  }
  const result = await doInsert(deps, svc, rag, params, kind, expiresAt);
  if (typeof result === "object") return result;
  return { success: true, data: { id: result } };
}

/** Insert via service (preferred) or atomicWrite (legacy). Returns new id or ToolResult on error. */
async function doInsert(
  deps: SharedWriteDeps, svc: MemoryService | null, rag: RAGPipeline | null,
  params: SharedWriteParams, kind: MemoryKind, expiresAt: number | null,
): Promise<string | ToolResult> {
  if (svc) {
    try {
      return await svc.insertShared({ category: params.category, content: params.content,
        tags: params.tags, confidence: params.confidence, status: params.status, kind, expires_at: expiresAt });
    } catch (e) { return { success: false, error: e instanceof Error ? e.message : String(e) }; }
  }
  if (rag) return atomicInsert(deps.memory, { ...params, kind, expires_at: expiresAt }, rag);
  return { success: false, error: "no_insert_path" };
}

async function atomicInsert(
  memory: MemoryDB, params: SharedWriteParams & { kind: MemoryKind }, rag: RAGPipeline,
): Promise<string | ToolResult> {
  let vec: Float32Array;
  try { vec = await embedWithTimeout(rag, params.content); }
  catch (e) { return { success: false, error: `embed_failed: ${e instanceof Error ? e.message : String(e)}` }; }
  if (!vec || vec.length === 0) return { success: false, error: "embed_empty" };
  try {
    memory.transaction(() => {
      memory.insertShared(params.id, params.category, params.content, params.tags, undefined,
        { confidence: params.confidence, status: params.status, kind: params.kind, expires_at: params.expires_at });
      memory.upsertEmbedding(params.id, "shared", vec);
    });
  } catch (e) { return { success: false, error: e instanceof Error ? e.message : String(e) }; }
  return params.id;
}
