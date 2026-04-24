// ─── Row Types for SQLite tables ──────────────────────────

export type MemoryStatus = "pending" | "active" | "rejected";

export interface ContextRow {
  id: string;
  title: string;
  content: string;
  tags: string;
  derived_from: string;
  agent_id: string | null;
  created_at: number;
  updated_at: number;
  confidence: number | null;
  status: MemoryStatus;
}

export interface ArchiveRow {
  id: string;
  title: string;
  content: string;
  tags: string;
  source_request_ids: string;
  confidence: "HIGH" | "LOW";
  agent_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface LogRow {
  id: number;
  request_id: string;
  session_id: string;
  agent_id: string;
  role: string;
  content: string;
  token_count: number | null;
  created_at: number;
}

export interface SharedRow {
  id: string;
  category: string;
  content: string;
  tags: string;
  source: string | null;
  created_at: number;
  updated_at: number;
  confidence: number | null;
  status: MemoryStatus;
}

export interface AgentMemRow {
  id: string;
  agent_id: string;
  content: string;
  tags: string;
  created_at: number;
  updated_at: number;
}

export interface FtsResult {
  id: string;
  title: string;
  tags: string;
  snippet: string;
  rank: number;
  created_at: number;
  updated_at: number;
}

export interface VecResult {
  id: string;
  layer: string;
  distance: number;
}

export interface ChatRow {
  id: string;
  title: string;
  model: string;
  source: string;
  kind: string;
  created_at: number;
  updated_at: number;
}

export interface ChatMessageRow {
  id: number;
  chat_id: string;
  role: string;
  content: string;
  reasoning: string | null;
  model: string | null;
  request_id: string | null;
  created_at: number;
}

export interface TgExcludedChatRow {
  chat_id: string;
  chat_title: string;
  reason: string;
  created_at: number;
}

export interface TgMessageRow {
  message_id: number;
  chat_id: string;
  chat_name: string;
  from_name: string;
  ts: number;
  text: string;
  created_at: number;
}

export interface TgSearchHit extends TgMessageRow {
  rank: number;
}

export type FreelanceSource = "fl.ru" | "kwork.ru" | "freelance.ru";
export type FreelanceStatus = "new" | "taken" | "rejected";

export interface FreelanceLeadRow {
  id: string;
  url: string;
  source: FreelanceSource;
  title: string;
  budget: number | null;
  score: number | null;
  reason: string | null;
  status: FreelanceStatus;
  created_at: number;
  updated_at: number;
}

// ─── Tasks (Phase 1 of tasks-vs-memory split) ────────────────────────
export type TaskScope =
  | "global"
  | "autonomous"
  | "free-agent"
  | "freelance"
  | "tg";

export type TaskStatus = "open" | "in_progress" | "done" | "cancelled";

export interface TaskRow {
  id: string;
  title: string;
  description: string;
  scope: TaskScope;
  status: TaskStatus;
  priority: number;
  due_at: number | null;
  source: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface SchedulerStateRow {
  key: string;
  value: string;
  updated_at: number;
}


