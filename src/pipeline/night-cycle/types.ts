import type { LogRow } from "../../db";

// ─── Types ───────────────────────────────────────────────

export interface NightCycleResult {
  processedLogs: number;
  sessionsProcessed: number;
  archiveEntriesCreated: number;
  antiPatternsFound: number;
  contradictionsResolved: number;
  sharedPruned: number;
  contextPruned: number;
  focusPruned: number;
  tasksPruned: number;
  straysCollected: number;
  // MEM-6 (mig 9): memory-dedup step counters (cluster-merge + expire mark).
  sharedDeduped: number;
  contextDeduped: number;
  expiredMarked: number;
  // M-03 (mig 13): rows whose salience was multiplied by 0.98^days_since
  // in the night-cycle decay-salience step (sum across 3 layers).
  salienceDecayed: number;
  // M-06: reflect-step counters (CoALA episodic → semantic consolidation).
  reflectGroupsExamined: number;
  reflectFactsPromoted: number;
  reflectEdgesCreated: number;
  reflectLLMFailures: number;
  errors: string[];
  lastProcessedId: number;
}

export interface CompressedEntry {
  title: string;
  content: string;
  tags: string;
  sourceRequestIds: string[];
  confidence: "HIGH" | "LOW";
}

// ─── Constants ───────────────────────────────────────────

export const BATCH_SIZE = 500;
export const FOCUS_KEY_LAST_PROCESSED = "night_cycle_last_processed_id";

// ─── Helpers ─────────────────────────────────────────────

export function buildConversationText(logs: LogRow[]): string {
  return logs
    .filter((l) => l.role === "user" || l.role === "assistant")
    .map((l) => `${l.role === "user" ? "User" : "Assistant"}: ${l.content}`)
    .join("\n\n");
}

/**
 * MiniMax-M2 wraps reasoning in <think>...</think> inside `content` (non-stream
 * path doesn't split it into `reasoning_content`). Strip before downstream
 * parsing so JSON/text consumers see only the final answer.
 */
export function stripThinkTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

export function parseJson(text: string): any {
  const stripped = stripThinkTags(text);
  const jsonMatch = stripped.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = jsonMatch ? jsonMatch[1].trim() : stripped;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
