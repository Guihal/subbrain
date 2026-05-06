/**
 * Legacy bridge: when FREE_AGENT=true and AGENT_POOL_ENABLED=true,
 * enqueue one startup task so the pool runs the old free-agent prompt.
 */
import type { AgentTasksRepository } from "@subbrain/core/repositories/agent-tasks.repo";
import { logger } from "@subbrain/core/lib/logger";
import { FREE_AGENT_TASK } from "../free-agent";

let bridged = false;

export function bridgeLegacyFreeAgent(repo: AgentTasksRepository): void {
  if (bridged) return;
  bridged = true;

  const free = process.env.FREE_AGENT === "true";
  const poolOn = process.env.AGENT_POOL_ENABLED === "true";
  if (!free || !poolOn) return;

  const log = logger.child("free-agent.bridge");
  try {
    const id = repo.enqueue({
      type: "free",
      prompt: FREE_AGENT_TASK,
      priority: 1,
      createdBy: "legacy-free-agent",
    });
    log.info("legacy task enqueued", { meta: { id } });
  } catch (err: unknown) {
    log.error("enqueue failed", { meta: { err: String(err) } });
  }
}
