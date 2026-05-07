import { logger } from "@subbrain/core/lib/logger";
import type { ModelRouter } from "@subbrain/core/lib/model-router";
import type { AgentTasksRepository } from "@subbrain/core/repositories/agent-tasks.repo";
import { createAgentTaskPool } from "./pool";
import { RunnerSlots } from "./pool/concurrency";
import { RateLimiter } from "./pool/rate-limits";
import { runTick } from "./tick";
import type { PoolDeps, RunFn } from "./types";

function getMaxConcurrent(): number {
  const raw = process.env.AGENT_POOL_MAX_CONCURRENT;
  const n = raw ? Number.parseInt(raw, 10) : 1;
  return Number.isNaN(n) || n < 1 ? 1 : n;
}

export interface AgentPoolSchedulerDeps {
  agentTasksRepo: AgentTasksRepository;
  router: ModelRouter;
  runFn: RunFn;
  intervalMs: number;
}

export function installAgentPoolScheduler(deps: AgentPoolSchedulerDeps): { stop: () => void } {
  const intervalMs = deps.intervalMs;
  const pool = createAgentTaskPool(deps.agentTasksRepo);
  const log = logger.child("agent-pool");
  const rateLimiter = new RateLimiter();
  const slots = new RunnerSlots(getMaxConcurrent());
  let tickRunning = false;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const poolDeps: PoolDeps = {
    pool,
    router: deps.router,
    log,
    runFn: deps.runFn,
    rateLimiter,
    slots,
  };

  const tick = async (): Promise<void> => {
    if (stopped || tickRunning) return;
    tickRunning = true;
    try {
      await runTick(poolDeps);
    } finally {
      tickRunning = false;
    }
  };

  timer = setInterval(() => {
    void tick();
  }, intervalMs);
  log.info("scheduler installed", { meta: { intervalMs, maxConcurrent: getMaxConcurrent() } });

  return {
    stop: () => {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

export { runTick } from "./tick";
