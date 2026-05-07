export type AgentTaskType = "free" | "clear" | "check-tg" | "research" | "find-new-task";
export type AgentTaskStatus = "pending" | "running" | "done" | "noop" | "failed";

export interface AgentTaskArtifact {
  type: string;
  content: unknown;
  url?: string;
}

export interface AgentTaskRecord {
  id: number;
  type: AgentTaskType;
  prompt: string;
  status: AgentTaskStatus;
  priority: number;
  scheduledAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  artifact: AgentTaskArtifact | null;
  reason: string | null;
  createdBy: string;
  createdAt: number;
}

export interface EnqueueInput {
  type: AgentTaskType;
  prompt: string;
  priority?: number;
  scheduledAt?: number;
  createdBy: string;
}

export interface DistributionRow {
  type: AgentTaskType;
  status: AgentTaskStatus;
  count: number;
}
