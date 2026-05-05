/**
 * Context-layer write. B-1 ownership check on update. + PR-A enforcement.
 * PR-A: validateCategoryAndContent + validateExpiresAt + defaultExpiresAt +
 * checkDuplicate (async, only when rag available).
 * Returns sync ToolResult|null when rag is absent (backward compat).
 */

import type { MemoryDB } from "@subbrain/core/db";
import { logger } from "@subbrain/core/lib/logger";
import { incrementCounter } from "@subbrain/core/lib/metrics";
import {
  defaultExpiresAt,
  validateCategoryAndContent,
  validateExpiresAt,
} from "../../../pipeline/agent-pipeline/post/validators";
import type { RAGPipeline } from "../../../rag";
import { checkDuplicate } from "../../../services/memory";
import type { ToolResult } from "../../types";
import type { WriteParams } from "./write";

const log = logger.child("memory.write-context");

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

export function writeContextCase(
  memory: MemoryDB,
  id: string,
  params: WriteParams,
  agentId: string | null,
  confidence: number,
  status: "active" | "pending",
  rag?: RAGPipeline | null,
): ToolResult | null | Promise<ToolResult | null> {
  const category = params.category || params.title || "general";
  const content = params.content;
  const existing = memory.getContext(id);

  if (!existing) {
    // Validate on insert.
    const catR = validateCategoryAndContent("context", category, content);
    if (!catR.ok) {
      const r = maybeReject(catR.reason, { category, layer: "context" });
      if (r) return r;
    }
    const expiresAt =
      typeof params.expires_at === "number"
        ? params.expires_at
        : defaultExpiresAt("context", category);
    const expR = validateExpiresAt(category, expiresAt);
    if (!expR.ok) {
      const r = maybeReject(expR.reason, { category });
      if (r) return r;
    }
    if (rag)
      return insertWithDedupAsync(
        memory,
        rag,
        id,
        params,
        agentId,
        confidence,
        status,
        category,
        expiresAt,
      );
    memory.insertContext(
      id,
      params.title || "Untitled",
      content,
      params.tags || "",
      [],
      agentId ?? undefined,
      { confidence, status, expires_at: expiresAt ?? undefined },
    );
    return null;
  }

  // Update path: B-1 ownership check.
  if (agentId !== null && existing.agent_id !== null && existing.agent_id !== agentId) {
    return { success: false, error: `forbidden: layer2_context row ${id} owned by another agent` };
  }
  memory.updateContext(id, { title: params.title, content, tags: params.tags, status, confidence });
  return null;
}

async function insertWithDedupAsync(
  memory: MemoryDB,
  rag: RAGPipeline,
  id: string,
  params: WriteParams,
  agentId: string | null,
  confidence: number,
  status: "active" | "pending",
  category: string,
  expiresAt: number | null,
): Promise<ToolResult | null> {
  try {
    const dd = await checkDuplicate(memory, rag, "context", category, params.content);
    if (dd.action === "reject") {
      const r = maybeReject(`duplicate (cosine=${dd.similarity?.toFixed(3)})`, { category });
      if (r) return r;
    } else if (dd.action === "supersede" && dd.supersedesId) {
      // Atomic: insert new row + mark old row superseded in one transaction.
      memory.transaction(() => {
        memory.insertContext(
          id,
          params.title || "Untitled",
          params.content,
          params.tags || "",
          [],
          agentId ?? undefined,
          { confidence, status, expires_at: expiresAt ?? undefined },
        );
        memory.updateContext(dd.supersedesId!, { superseded_by: id });
      });
      return { success: true, data: { id, superseded: dd.supersedesId } } as ToolResult;
    }
  } catch (e) {
    log.warn(`dedup_error: ${String(e)}`);
    return {
      success: false,
      error: { code: "supersede_failed", message: e instanceof Error ? e.message : String(e) },
    };
  }
  memory.insertContext(
    id,
    params.title || "Untitled",
    params.content,
    params.tags || "",
    [],
    agentId ?? undefined,
    { confidence, status, expires_at: expiresAt ?? undefined },
  );
  return null;
}
