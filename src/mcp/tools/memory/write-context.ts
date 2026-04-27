import type { MemoryDB } from "../../../db";
import type { ToolResult } from "../../types";
import type { WriteParams } from "./write";

/**
 * Context-layer write. B-1 ownership check on update: an agent can update
 * its own row OR a legacy NULL-agent_id row. Cross-agent overwrite is
 * rejected. Admin (`agentId === null`) bypasses.
 */
export function writeContextCase(
  memory: MemoryDB,
  id: string,
  params: WriteParams,
  agentId: string | null,
  confidence: number,
  status: "active" | "pending",
): ToolResult | null {
  const existing = memory.getContext(id);
  if (existing) {
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
    memory.updateContext(id, {
      title: params.title,
      content: params.content,
      tags: params.tags,
      status,
      confidence,
    });
  } else {
    // B-1: agent_id from server-controlled `agentId`, NOT params.agent_id
    // (would let an agent spoof another agent's private bucket).
    memory.insertContext(
      id,
      params.title || "Untitled",
      params.content,
      params.tags || "",
      [],
      agentId ?? undefined,
      { confidence, status },
    );
  }
  return null;
}
