import { Mutex } from "@subbrain/core/lib/mutex";
import type { AgentTaskType } from "@subbrain/core/db/tables/agent-tasks/types";

export class RunnerSlots {
  private readonly mutex = new Mutex();
  private readonly active = new Map<AgentTaskType, number>();
  readonly maxConcurrent: number;

  constructor(maxConcurrent: number) {
    this.maxConcurrent = maxConcurrent;
  }

  async tryAcquire(type: AgentTaskType): Promise<boolean> {
    const release = await this.mutex.acquire();
    try {
      const current = this.active.get(type) ?? 0;
      if (current >= this.maxConcurrent) return false;
      this.active.set(type, current + 1);
      return true;
    } finally {
      release();
    }
  }

  release(type: AgentTaskType): void {
    const current = this.active.get(type) ?? 0;
    if (current > 0) this.active.set(type, current - 1);
  }

  totalActive(): number {
    let sum = 0;
    for (const v of this.active.values()) sum += v;
    return sum;
  }
}
