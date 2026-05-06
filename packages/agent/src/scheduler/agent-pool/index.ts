import type { AgentTasksRepository } from "@subbrain/core/repositories/agent-tasks.repo";
import type { ModelRouter } from "@subbrain/core/lib/model-router";
import { logger } from "@subbrain/core/lib/logger";
import { createAgentTaskPool } from "./pool";
import type { PoolDeps, RunFn } from "./types";
import { RateLimiter } from "./pool/rate-limits";

const ZOMBIE_CUTOFF_S = 1800;

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
  let tickRunning = false;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const poolDeps: PoolDeps = { pool, router: deps.router, log, runFn: deps.runFn, rateLimiter };

  const tick = async (): Promise<void> => {
    if (stopped || tickRunning) return;
    tickRunning = true;
    try { await runTick(poolDeps); } finally { tickRunning = false; }
  };

  timer = setInterval(() => { void tick(); }, intervalMs);
  log.info("scheduler installed", { meta: { intervalMs } });

  return {
    stop: () => { stopped = true; if (timer) { clearInterval(timer); timer = null; } },
  };
}

export async function runTick(deps: PoolDeps): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);

  const zombies = deps.pool.markZombiesFailed(nowSec - ZOMBIE_CUTOFF_S);
  if (zombies > 0) deps.log.warn("zombies marked failed", { meta: { count: zombies } });

  if (deps.router.isOverloaded) { deps.log.info("router overloaded, skip"); return; }

  const task = deps.pool.claim();
  if (!task) { deps.log.info("no pending tasks"); return; }

  if (deps.rateLimiter && !deps.rateLimiter.allow(task.type)) {
    deps.log.info("rate limit cooldown, skip", { meta: { type: task.type } });
    return;
  }

  deps.log.info("task claimed", { meta: { id: task.id, type: task.type } });

  let result: Awaited<ReturnType<typeof deps.runFn>>;
  try { result = await deps.runFn(task); }
  catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    deps.log.error("runFn threw", { meta: { id: task.id, reason } });
    deps.pool.fail(task.id, reason);
    return;
  }

  if (result.status === "complete") {
    if (result.artifact) {
      deps.pool.complete(task.id, result.artifact);
      deps.rateLimiter?.recordCompletion(task.type);
      deps.log.info("task complete", { meta: { id: task.id } });
    } else {
      deps.pool.fail(task.id, "complete missing artifact");
      deps.log.warn("complete missing artifact", { meta: { id: task.id } });
    }
  } else if (result.status === "noop") {
    deps.pool.noop(task.id, result.reason ?? "no reason given");
    deps.rateLimiter?.recordCompletion(task.type);
    deps.log.info("task noop", { meta: { id: task.id } });
  } else {
    deps.pool.fail(task.id, result.reason ?? "no reason given");
    deps.log.info("task failed", { meta: { id: task.id } });
  }
}
