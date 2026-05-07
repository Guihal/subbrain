import type { AgentTaskType } from "@subbrain/core/db/tables/agent-tasks/types";

const COOLDOWNS: Record<string, number> = {
  free: 60_000,
  scheduled: 300_000,
};

const DEFAULT_COOLDOWN = 60_000;

export class RateLimiter {
  private readonly lastCompletion = new Map<AgentTaskType, number>();

  allow(type: AgentTaskType, now = Date.now()): boolean {
    const last = this.lastCompletion.get(type);
    if (last === undefined) return true;
    const cooldown = COOLDOWNS[type] ?? DEFAULT_COOLDOWN;
    return now - last >= cooldown;
  }

  recordCompletion(type: AgentTaskType, now = Date.now()): void {
    this.lastCompletion.set(type, now);
  }
}
