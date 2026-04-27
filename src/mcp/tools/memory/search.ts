import type { MemoryDB, FtsResult } from "../../../db";
import type { ToolResult } from "../../types";

export function searchMemory(
  memory: MemoryDB,
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
    results.context = memory.searchContext(query, n, ctxOpts);
  }
  if (target === "all" || target === "archive") {
    results.archive = memory.searchArchive(query, n);
  }
  if (target === "all" || target === "shared") {
    results.shared = memory.searchShared(query, n);
  }
  if (target === "all" || target === "focus") {
    // Focus is a KV store without FTS — linear scan. Layer is small by
    // design (< ~100 entries), so O(n) match is fine.
    const q = query.toLowerCase();
    const focus = memory.getAllFocus();
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
