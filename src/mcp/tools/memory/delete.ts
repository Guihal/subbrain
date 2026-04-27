import type { MemoryDB } from "../../../db";
import type { ToolResult } from "../../types";

export function deleteMemory(
  memory: MemoryDB,
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
      const existing = memory.getContext(id);
      if (
        existing &&
        agentId !== null &&
        existing.agent_id !== null &&
        existing.agent_id !== agentId
      ) {
        return {
          success: false,
          error: `forbidden: layer2_context row ${id} owned by another agent`,
        };
      }
      memory.deleteContext(id);
      break;
    }
    case "archive":
      memory.deleteArchive(id);
      break;
    case "shared":
      memory.deleteShared(id);
      break;
    case "agent":
      memory.deleteAgentMemory(id);
      break;
    default:
      return { success: false, error: `Unknown layer: ${layer}` };
  }
  memory.deleteEmbedding(id);
  return { success: true };
}
