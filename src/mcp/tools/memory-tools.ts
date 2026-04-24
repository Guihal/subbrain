/**
 * Memory CRUD operations extracted from ToolExecutor.
 */
import { randomUUID } from "crypto";
import type { MemoryDB, FtsResult } from "../../db";
import type { RAGPipeline } from "../../rag";
import type { ToolResult } from "../types";

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

  write(params: {
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
    agent_id?: string;
    key?: string;
  }): ToolResult {
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

      case "context":
        if (this.memory.getContext(id)) {
          this.memory.updateContext(id, {
            title: params.title,
            content: params.content,
            tags: params.tags,
            status,
            confidence,
          });
        } else {
          this.memory.insertContext(
            id,
            params.title || "Untitled",
            params.content,
            params.tags || "",
            [],
            params.agent_id,
            { confidence, status },
          );
        }
        break;

      case "archive":
        if (this.memory.getArchive(id)) {
          this.memory.updateArchive(id, {
            title: params.title,
            content: params.content,
            tags: params.tags,
            confidence: archiveLabel,
          });
        } else {
          this.memory.insertArchive(
            id,
            params.title || "Untitled",
            params.content,
            params.tags || "",
            [],
            archiveLabel,
            params.agent_id,
          );
        }
        break;

      case "shared":
        this.memory.insertShared(
          id,
          params.category || "general",
          params.content,
          params.tags || "",
          undefined,
          { confidence, status },
        );
        break;

      case "agent":
        if (!params.agent_id)
          return { success: false, error: "agent_id required for agent layer" };
        this.memory.insertAgentMemory(
          id,
          params.agent_id,
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

  delete(id: string, layer: string): ToolResult {
    switch (layer) {
      case "context":
        this.memory.deleteContext(id);
        break;
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

  search(query: string, layer?: string, limit?: number): ToolResult {
    // Q-10: hard cap on per-layer result count to avoid unbounded payloads
    // when a caller forwards an LLM-chosen `limit`.
    const MAX_LIMIT = 50;
    const n = Math.min(MAX_LIMIT, Math.max(1, limit || 10));
    const target = layer || "all";
    const results: Record<string, FtsResult[]> = {};

    if (target === "all" || target === "context") {
      results.context = this.memory.searchContext(query, n);
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
