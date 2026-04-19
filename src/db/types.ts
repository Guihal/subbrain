// ─── Row Types for SQLite tables ──────────────────────────

export interface ContextRow {
  id: string;
  title: string;
  content: string;
  tags: string;
  derived_from: string;
  agent_id: string | null;
  created_at: number;
  updated_at: number;
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
