import type { LogRow } from "../../db";

// ─── Types ───────────────────────────────────────────────

export interface NightCycleResult {
  processedLogs: number;
  sessionsProcessed: number;
  archiveEntriesCreated: number;
  antiPatternsFound: number;
  contradictionsResolved: number;
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

export function parseJson(text: string): any {
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = jsonMatch ? jsonMatch[1].trim() : text.trim();
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
