/**
 * Memory CRUD operations extracted from ToolExecutor.
 *
 * MEM-2 (M-01): the `shared` layer write path embeds **before** insert and
 * wraps both rows (`shared_memory` + `vec_embeddings`) in a single
 * `db.transaction()`. Embed-fail therefore never leaves a row without a
 * vector. Mirror of `MemoryService.insertShared` / `extractors.writeShared`
 * — kept inline here to avoid threading `MemoryService` through every
 * ToolExecutor caller (including legacy tests that pass `() => null` for
 * RAG and rely on the sync raw-insert fallback).
 */
import { randomUUID } from "crypto";
import type { MemoryDB, FtsResult } from "../../db";
import type { RAGPipeline } from "../../rag";
import type { ToolResult } from "../types";

const EMBED_TIMEOUT_MS = 5000;

async function embedWithTimeout(
  rag: RAGPipeline,
  content: string,
): Promise<Float32Array> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      rag.embedContent(content),
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error("embed_timeout")), EMBED_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class MemoryTools {
  constructor(
    private memory: MemoryDB,
    private getRag: () => RAGPipeline | null,
  ) {}

  read(id: string, layer?: string): ToolResult {
    let data: unknown = null;

    if (!layer || layer === "context") data = this.memory.getContext(id);
    if (!data && (!layer || layer === "archive"))
      data = this.memory.getArchive(id);
    if (!data && (!layer || layer === "shared")) {
      data = this.memory.db
        .query("SELECT * FROM shared_memory WHERE id = ?")
        .get(id);
    }
    if (!data && (!layer || layer === "agent")) {
      data = this.memory.db
        .query("SELECT * FROM agent_memory WHERE id = ?")
        .get(id);
    }

    if (!data) return { success: false, error: "Not found" };
    return { success: true, data };
  }

  write(
    params: {
      layer: string;
      content: string;
      /**
       * Confidence 0..1 (MEM-5 / PR 22a). Enforced as required by the registry
       * TypeBox schema (`memory_write`). Direct callers of `MemoryTools.write`
       * (internal tests, legacy code paths) may omit it, in which case a
       * conservative `HIGH`/'active' baseline is used — public tool callers
       * cannot reach this branch because registry validation rejects the
       * request upstream.
       */
      confidence?: number | "HIGH" | "LOW";
      id?: string;
      title?: string;
      tags?: string;
      category?: string;
      /**
       * B-1 spoofing note: `agent_id` from `params` is ignored for context /
       * archive / agent layers — those use the server-controlled `agentId`
       * argument below. An agent must not be able to write into another
       * agent's private bucket by passing a forged `args.agent_id`.
       */
      agent_id?: string;
      key?: string;
    },
    /**
     * B-1: server-controlled per-agent identity. `null` = unscoped (admin /
     * legacy back-compat). Schedulers and agent-loop entry points populate
     * this from the request context; REST/MCP routes default to null.
     */
    agentId: string | null = null,
  ): ToolResult | Promise<ToolResult> {
    const id = params.id || randomUUID();
    // MEM-5 (PR 22a): numeric confidence 0..1 classifies the row via the
    // MEMORY_AUTOACCEPT_CONFIDENCE threshold (default 0.8):
    //   ≥ threshold → 'active', below → 'pending'.
    // Archive layer retains its legacy HIGH/LOW label — mapped from the same
    // numeric score (≥ 0.8 → HIGH) so the registry surface stays uniform.
    // Legacy string form ("HIGH"/"LOW") from direct-test callers is preserved
    // as a fallback — they never reach the registry validator.
    const THRESHOLD = Number(process.env.MEMORY_AUTOACCEPT_CONFIDENCE ?? 0.8);
    let numericConfidence: number;
    if (typeof params.confidence === "number") {
      numericConfidence = params.confidence;
    } else if (params.confidence === "LOW") {
      numericConfidence = 0.5;
    } else {
      numericConfidence = 1.0; // "HIGH" or undefined → confirmed/auto-accept
    }
    const confidence = Math.min(1, Math.max(0, numericConfidence));
    const status: "active" | "pending" =
      confidence >= THRESHOLD ? "active" : "pending";
    const archiveLabel: "HIGH" | "LOW" = confidence >= 0.8 ? "HIGH" : "LOW";

    switch (params.layer) {
      case "focus":
        if (!params.key)
          return { success: false, error: "key required for focus layer" };
        this.memory.setFocus(params.key, params.content);
        return { success: true, data: { key: params.key } };

      case "context": {
        const existing = this.memory.getContext(id);
        if (existing) {
          // B-1 ownership check: an agent can update its own row OR a legacy
          // (NULL agent_id) row. Cross-agent overwrite by guessing/leaking
          // an id is rejected. Admin (agentId === null) bypasses the check.
          if (
            agentId !== null &&
            existing.agent_id !== null &&
            existing.agent_id !== agentId
          ) {
            return {
              success: false,
              error: `forbidden: layer2_context row ${id} owned by another agent`,
            };
          }
          this.memory.updateContext(id, {
            title: params.title,
            content: params.content,
            tags: params.tags,
            status,
            confidence,
          });
        } else {
          // B-1: agent_id from server-controlled `agentId`, NOT params.agent_id
          // (would let an agent spoof another agent's private bucket).
          this.memory.insertContext(
            id,
            params.title || "Untitled",
            params.content,
            params.tags || "",
            [],
            agentId ?? undefined,
            { confidence, status },
          );
        }
        break;
      }

      case "archive":
        if (this.memory.getArchive(id)) {
          this.memory.updateArchive(id, {
            title: params.title,
            content: params.content,
            tags: params.tags,
            confidence: archiveLabel,
          });
        } else {
          // Archive is shared-by-design (MEM-3); agentId is recorded for
          // attribution only, never used as a reader filter. Server-side
          // `agentId` still preferred over LLM-supplied params.agent_id.
          this.memory.insertArchive(
            id,
            params.title || "Untitled",
            params.content,
            params.tags || "",
            [],
            archiveLabel,
            agentId ?? undefined,
          );
        }
        break;

      case "shared": {
        const rag = this.getRag();
        if (rag) {
          // MEM-2 (M-01): atomic embed+insert. Returns a Promise so the
          // caller (registry handler — accepts ToolResult|Promise<ToolResult>)
          // awaits the upstream embed call. Skips the bottom-of-method
          // fire-and-forget indexEntry — the transaction already wrote
          // vec_embeddings.
          return this.writeSharedAtomic(
            id,
            params.category || "general",
            params.content,
            params.tags || "",
            confidence,
            status,
            rag,
          );
        }
        // Legacy fallback: caller did not wire a RAG pipeline (older tests,
        // boot-time scripts). Sync raw insert; row will lack vec_embeddings
        // until a follow-up indexEntry runs. Acceptable only outside prod.
        this.memory.insertShared(
          id,
          params.category || "general",
          params.content,
          params.tags || "",
          undefined,
          { confidence, status },
        );
        break;
      }

      case "agent":
        // agent_memory is a separate per-agent bucket (private API
        // `getAgentMemories(agentId)`). Identity must come from the server
        // (`agentId` arg) — never from LLM-supplied `params.agent_id`. If
        // server passes null (admin / unscoped), the request is rejected.
        if (!agentId)
          return {
            success: false,
            error: "agent layer requires server-bound agentId (set by route or scheduler, not by tool args)",
          };
        this.memory.insertAgentMemory(
          id,
          agentId,
          params.content,
          params.tags || "",
        );
        break;

      default:
        return { success: false, error: `Unknown layer: ${params.layer}` };
    }

    // Fire-and-forget: embed for RAG index. The "focus" layer returned earlier
    // in the switch and never reaches this point, so no extra guard is needed —
    // params.layer here is always one of context | archive | shared | agent.
    const rag = this.getRag();
    if (rag) {
      rag.indexEntry(id, params.layer, params.content).catch(() => {});
    }

    return { success: true, data: { id } };
  }

  /**
   * MEM-2 (M-01): embed-first then transactional insert+upsertEmbedding for
   * the `shared` layer. Mirrors `MemoryService.insertShared` so we keep the
   * same atomicity guarantee without threading the service through every
   * ToolExecutor caller.
   */
  private async writeSharedAtomic(
    id: string,
    category: string,
    content: string,
    tags: string,
    confidence: number,
    status: "active" | "pending",
    rag: RAGPipeline,
  ): Promise<ToolResult> {
    let vec: Float32Array;
    try {
      vec = await embedWithTimeout(rag, content);
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
      this.memory.transaction(() => {
        this.memory.insertShared(
          id,
          category,
          content,
          tags,
          undefined,
          { confidence, status },
        );
        this.memory.upsertEmbedding(id, "shared", vec);
      });
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    return { success: true, data: { id } };
  }

  delete(
    id: string,
    layer: string,
    /**
     * B-1: server-controlled agentId for ownership check on context layer.
     * Symmetric to `write`: an agent can delete only its own row OR a
     * legacy NULL row. Admin (`null`) bypasses the check.
     */
    agentId: string | null = null,
  ): ToolResult {
    switch (layer) {
      case "context": {
        const existing = this.memory.getContext(id);
        if (existing && agentId !== null && existing.agent_id !== null && existing.agent_id !== agentId) {
          return {
            success: false,
            error: `forbidden: layer2_context row ${id} owned by another agent`,
          };
        }
        this.memory.deleteContext(id);
        break;
      }
      case "archive":
        this.memory.deleteArchive(id);
        break;
      case "shared":
        this.memory.deleteShared(id);
        break;
      case "agent":
        this.memory.deleteAgentMemory(id);
        break;
      default:
        return { success: false, error: `Unknown layer: ${layer}` };
    }
    this.memory.deleteEmbedding(id);
    return { success: true };
  }

  search(
    query: string,
    layer?: string,
    limit?: number,
    /**
     * B-1: per-agent identity for context-layer scoping. `null` = admin
     * (no filter); set string = filter `(agent_id = ? OR agent_id IS NULL)`.
     * Archive + shared remain global per MEM-3.
     */
    agentId: string | null = null,
  ): ToolResult {
    // Q-10: hard cap on per-layer result count to avoid unbounded payloads
    // when a caller forwards an LLM-chosen `limit`.
    const MAX_LIMIT = 50;
    const n = Math.min(MAX_LIMIT, Math.max(1, limit || 10));
    const target = layer || "all";
    const results: Record<string, FtsResult[]> = {};
    const ctxOpts = agentId ? { agentId } : undefined;

    if (target === "all" || target === "context") {
      results.context = this.memory.searchContext(query, n, ctxOpts);
    }
    if (target === "all" || target === "archive") {
      results.archive = this.memory.searchArchive(query, n);
    }
    if (target === "all" || target === "shared") {
      results.shared = this.memory.searchShared(query, n);
    }
    if (target === "all" || target === "focus") {
      // Focus is a KV store without FTS — linear scan. Layer is small by
      // design (< ~100 entries), so O(n) match is fine.
      const q = query.toLowerCase();
      const focus = this.memory.getAllFocus();
      results.focus = Object.entries(focus)
        .filter(
          ([k, v]) =>
            k.toLowerCase().includes(q) || v.toLowerCase().includes(q),
        )
        .slice(0, n)
        .map(([k, v]) => ({
          id: k,
          title: k,
          tags: "",
          snippet: v,
          rank: 0,
          created_at: 0,
          updated_at: 0,
        }));
    }

    return { success: true, data: results };
  }

  contextSummary(sessionId: string): ToolResult {
    const logs = this.memory.getLogsBySession(sessionId, 50);
    const focus = this.memory.getAllFocus();

    return {
      success: true,
      data: {
        focus,
        recent_log_count: logs.length,
        recent_logs: logs.slice(0, 10).map((l) => ({
          role: l.role,
          content: l.content.substring(0, 200),
          agent_id: l.agent_id,
        })),
      },
    };
  }
}
