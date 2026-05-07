/**
 * Memory write dispatcher. Per-layer cases delegate to small helpers.
 * Shared-layer logic (embed-first transactional + service delegate path)
 * lives in `./write-shared.ts` (M-FINAL2 / MEM-2 / M-07.1).
 */
import { randomUUID } from "node:crypto";
import type { MemoryDB } from "@subbrain/core/db";
import type { RAGPipeline } from "../../../rag";
import type { MemoryService } from "../../../services/memory";
import type { ToolResult } from "../../types";
import { writeArchiveCase } from "./write-archive";
import { writeContextCase } from "./write-context";
import { writeShared } from "./write-shared/index";

export interface WriteDeps {
  memory: MemoryDB;
  getRag: () => RAGPipeline | null;
  memoryService: MemoryService | null;
}

export interface WriteParams {
  layer: string;
  content: string;
  /**
   * Confidence 0..1 (MEM-5 / PR 22a). Required by registry TypeBox schema.
   * Direct callers (internal tests) may omit it; conservative HIGH/'active'
   * baseline applies.
   */
  confidence?: number | "HIGH" | "LOW";
  id?: string;
  title?: string;
  tags?: string;
  category?: string;
  /**
   * B-1 spoofing note: ignored for context/archive/agent layers — those
   * use the server-controlled `agentId` argument.
   */
  agent_id?: string;
  key?: string;
  // PR-A: unix seconds expiry (optional; default populated by category).
  expires_at?: number;
}

export function writeMemory(
  deps: WriteDeps,
  params: WriteParams,
  /**
   * B-1: server-controlled per-agent identity. `null` = unscoped (admin /
   * legacy back-compat).
   */
  agentId: string | null = null,
): ToolResult | Promise<ToolResult> {
  const id = params.id || randomUUID();
  const { confidence, status } = classifyConfidence(params.confidence);

  switch (params.layer) {
    case "focus":
      if (!params.key) return { success: false, error: "key required for focus layer" };
      deps.memory.setFocus(params.key, params.content);
      return { success: true, data: { key: params.key } };

    case "context": {
      // PR-A: writeContextCase is async when rag present (dedup), sync otherwise.
      const rag = deps.getRag();
      const ctxResult = writeContextCase(deps.memory, id, params, agentId, confidence, status, rag);
      if (ctxResult instanceof Promise) {
        return ctxResult.then((err) => {
          if (err) return err;
          if (rag) rag.indexEntry(id, "context", params.content).catch(() => {});
          return { success: true, data: { id } } as ToolResult;
        });
      }
      if (ctxResult) return ctxResult;
      if (rag) rag.indexEntry(id, "context", params.content).catch(() => {});
      break;
    }

    case "archive":
      writeArchiveCase(deps.memory, id, params, agentId, confidence);
      break;

    case "shared":
      // Shared returns its own ToolResult. Service path indexes itself;
      // writeSharedAtomic wrote vec_embeddings inside the transaction.
      // Final raw fallback skips indexEntry (rag is null in that branch).
      return writeShared(deps, {
        id,
        category: params.category || "general",
        content: params.content,
        tags: params.tags || "",
        confidence,
        status,
        expires_at: params.expires_at,
      });

    case "agent":
      // agent_memory is a per-agent bucket. Identity must come from
      // the server (`agentId` arg). Null server-identity rejected.
      if (!agentId)
        return {
          success: false,
          error:
            "agent layer requires server-bound agentId (set by route or scheduler, not by tool args)",
        };
      deps.memory.insertAgentMemory(id, agentId, params.content, params.tags || "");
      break;

    default:
      return { success: false, error: `Unknown layer: ${params.layer}` };
  }

  // Fire-and-forget: embed for RAG index. Reachable for archive | agent
  // (focus + shared returned earlier; context handled above).
  const rag = deps.getRag();
  if (rag) {
    rag.indexEntry(id, params.layer, params.content).catch(() => {});
  }

  return { success: true, data: { id } };
}

/**
 * MEM-5 (PR 22a): numeric confidence 0..1 → 'active' (≥ threshold) or
 * 'pending'. Legacy string form ("HIGH"/"LOW") preserved as fallback —
 * registry validator rejects strings, so only direct test callers reach it.
 * M-12 (mig 15): archive now stores REAL [0..1] like shared/context.
 */
function classifyConfidence(raw: number | "HIGH" | "LOW" | undefined): {
  confidence: number;
  status: "active" | "pending";
} {
  const THRESHOLD = Number(process.env.MEMORY_AUTOACCEPT_CONFIDENCE ?? 0.8);
  let numeric: number;
  if (typeof raw === "number") numeric = raw;
  else if (raw === "LOW") numeric = 0.5;
  else numeric = 1.0; // "HIGH" or undefined → confirmed/auto-accept
  const confidence = Math.min(1, Math.max(0, numeric));
  return { confidence, status: confidence >= THRESHOLD ? "active" : "pending" };
}
