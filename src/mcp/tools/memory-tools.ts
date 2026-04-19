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
    id?: string;
    title?: string;
    tags?: string;
    category?: string;
    agent_id?: string;
    confidence?: "HIGH" | "LOW";
    key?: string;
  }): ToolResult {
    const id = params.id || randomUUID();

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
          });
        } else {
          this.memory.insertContext(
            id,
            params.title || "Untitled",
            params.content,
            params.tags || "",
            [],
            params.agent_id,
          );
        }
        break;

      case "archive":
        if (this.memory.getArchive(id)) {
          this.memory.updateArchive(id, {
            title: params.title,
            content: params.content,
            tags: params.tags,
            confidence: params.confidence,
          });
        } else {
          this.memory.insertArchive(
            id,
            params.title || "Untitled",
            params.content,
            params.tags || "",
            [],
            params.confidence || "HIGH",
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

    // Fire-and-forget: embed for RAG index
    const rag = this.getRag();
    if (rag && params.layer !== "focus") {
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
    const n = limit || 10;
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
