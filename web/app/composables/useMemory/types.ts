export type MemoryTab =
  | "focus"
  | "shared"
  | "context"
  | "archive"
  | "agent"
  | "log";

export type ListLayer = Exclude<MemoryTab, "focus">;

export interface FocusEntry {
  key: string;
  value: string;
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

export interface AgentMemRow {
  id: string;
  agent_id: string;
  content: string;
  tags: string;
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

export type MemoryRow =
  | ({ __kind: "focus" } & FocusEntry)
  | ({ __kind: "shared" } & SharedRow)
  | ({ __kind: "context" } & ContextRow)
  | ({ __kind: "archive" } & ArchiveRow)
  | ({ __kind: "agent" } & AgentMemRow)
  | ({ __kind: "log" } & LogRow);

export interface ListEnvelope<T> {
  items: T[];
  total: number;
}

export const LAYER_SCHEMAS = {
  focus: { fields: ["key", "value"] as const, readonly: false, kind: "kv" as const },
  shared: { fields: ["category", "content", "tags"] as const, readonly: false, kind: "list" as const },
  context: { fields: ["title", "content", "tags"] as const, readonly: false, kind: "list" as const },
  archive: {
    fields: ["title", "content", "tags", "confidence"] as const,
    readonly: false,
    kind: "list" as const,
  },
  agent: { fields: ["content", "tags"] as const, readonly: false, kind: "list" as const },
  log: { fields: [] as const, readonly: true, kind: "list" as const },
} as const;
