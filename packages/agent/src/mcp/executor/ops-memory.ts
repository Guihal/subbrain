import { toLegacy } from "../types";
import type { ToolResult } from "../types";
import type { ExecutorState } from "./types";

export function memoryRead(s: ExecutorState, id: string, layer?: string): ToolResult {
  return s.memoryTools.read(id, layer);
}

// MEM-2 (M-01): the `shared` layer returns a Promise so callers (registry
// handler — accepts ToolResult | Promise<ToolResult>) await embed+insert.
// Other layers stay sync.
// M-12 (mig 15): unified numeric confidence [0..1]. Legacy "HIGH"/"LOW" strings
// still accepted by `MemoryTools.write` fallback for direct test callers
// (registry validator rejects strings — see memory-tools.ts).
export function memoryWrite(
  s: ExecutorState,
  params: {
    layer: string;
    content: string;
    id?: string;
    title?: string;
    tags?: string;
    category?: string;
    agent_id?: string;
    confidence?: number | "HIGH" | "LOW";
    key?: string;
  },
  agentId: string | null = null,
): ToolResult | Promise<ToolResult> {
  return s.memoryTools.write(params, agentId);
}

export function memoryDelete(
  s: ExecutorState,
  id: string,
  layer: string,
  agentId: string | null = null,
): ToolResult {
  return s.memoryTools.delete(id, layer, agentId);
}

export function memorySearch(
  s: ExecutorState,
  query: string,
  layer?: string,
  limit?: number,
  agentId: string | null = null,
): ToolResult {
  return s.memoryTools.search(query, layer, limit, agentId);
}

export async function ragSearch(
  s: ExecutorState,
  query: string,
  layers?: ("context" | "archive" | "shared")[],
  topN?: number,
  skipRerank?: boolean,
  agentId: string | null = null,
): Promise<ToolResult> {
  return toLegacy(await s.embedTools.ragSearch(query, layers, topN, skipRerank, agentId));
}

export function contextSummary(s: ExecutorState, sessionId: string): ToolResult {
  return s.memoryTools.contextSummary(sessionId);
}
