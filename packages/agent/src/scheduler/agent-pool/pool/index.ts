import type { AgentTaskArtifact, AgentTaskRecord } from "@subbrain/core/db/tables/agent-tasks/types";
import type { AgentTasksRepository } from "@subbrain/core/repositories/agent-tasks.repo";
import type { AgentTaskPool } from "../types";

export function createAgentTaskPool(repo: AgentTasksRepository): AgentTaskPool {
  const now = () => Math.floor(Date.now() / 1000);

  return {
    claim: (): AgentTaskRecord | null => repo.claimNext(now()),
    peekNextPending: (): AgentTaskRecord | null => repo.peekNextPending(now()),
    claimById: (id: number): AgentTaskRecord | null => repo.claim(id, now()),
    complete: (id: number, artifact: AgentTaskArtifact): void =>
      repo.complete(id, artifact, now()),
    noop: (id: number, reason: string): void => repo.noop(id, reason, now()),
    fail: (id: number, reason: string): void => repo.fail(id, reason, now()),
    markZombiesFailed: (cutoff: number): number => repo.markZombiesFailed(cutoff),
  };
}
