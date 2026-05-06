import type { AgentTaskArtifact, AgentTaskRecord, AgentTaskType } from "@subbrain/core/db/tables/agent-tasks/types";
import type { LogEntry } from "@subbrain/core/lib/logger";

export interface RunnerResult {
  status: "complete" | "noop" | "failed";
  artifact?: AgentTaskArtifact;
  reason?: string;
}

export type RunFn = (task: AgentTaskRecord) => Promise<RunnerResult>;

export interface PoolDeps {
  pool: AgentTaskPool;
  router: { isOverloaded: boolean };
  log: { info: (message: string, extra?: Partial<LogEntry>) => void; warn: (message: string, extra?: Partial<LogEntry>) => void; error: (message: string, extra?: Partial<LogEntry>) => void };
  runFn: RunFn;
  rateLimiter?: { allow: (type: AgentTaskType) => boolean; recordCompletion: (type: AgentTaskType) => void };
}

export interface AgentTaskPool {
  claim: () => AgentTaskRecord | null;
  complete: (id: number, artifact: AgentTaskArtifact) => void;
  noop: (id: number, reason: string) => void;
  fail: (id: number, reason: string) => void;
  markZombiesFailed: (cutoff: number) => number;
}
