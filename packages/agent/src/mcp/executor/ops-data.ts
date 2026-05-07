import type { ToolResult } from "../types";
import { toLegacy } from "../types";
import type { ExecutorState } from "./types";

// ─── Logging ─────────────────────────────────────────────

export function logAppend(
  s: ExecutorState,
  requestId: string,
  sessionId: string,
  agentId: string,
  role: string,
  content: string,
  tokenCount?: number,
): ToolResult {
  return toLegacy(s.logTools.append(requestId, sessionId, agentId, role, content, tokenCount));
}

export function logRead(
  s: ExecutorState,
  sessionId?: string,
  requestId?: string,
  limit?: number,
): ToolResult {
  return toLegacy(s.logTools.read(sessionId, requestId, limit));
}

export async function compressHistory(
  s: ExecutorState,
  messages: { role: string; content: string }[],
): Promise<ToolResult> {
  return toLegacy(await s.logTools.compressHistory(messages));
}

// ─── Embeddings ──────────────────────────────────────────

export async function embedText(
  s: ExecutorState,
  text: string,
  type: "text" | "code" = "text",
): Promise<ToolResult> {
  return toLegacy(await s.embedTools.embedText(text, type));
}

export async function embedSearch(
  s: ExecutorState,
  query: string,
  topK?: number,
  layer?: string,
): Promise<ToolResult> {
  return toLegacy(await s.embedTools.embedSearch(query, topK, layer));
}

export async function rerank(
  s: ExecutorState,
  query: string,
  passages: string[],
  topN?: number,
): Promise<ToolResult> {
  return toLegacy(await s.embedTools.rerank(query, passages, topN));
}
