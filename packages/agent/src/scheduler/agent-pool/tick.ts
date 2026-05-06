import type { PoolDeps } from "./types";

const ZOMBIE_CUTOFF_S = 1800;

function getMaxConcurrent(): number {
  const raw = process.env.AGENT_POOL_MAX_CONCURRENT;
  const n = raw ? Number.parseInt(raw, 10) : 1;
  return Number.isNaN(n) || n < 1 ? 1 : n;
}

export async function runTick(deps: PoolDeps): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);

  const zombies = deps.pool.markZombiesFailed(nowSec - ZOMBIE_CUTOFF_S);
  if (zombies > 0) deps.log.warn("zombies marked failed", { meta: { count: zombies } });

  if (deps.router.isOverloaded) { deps.log.info("router overloaded, skip"); return; }

  const maxConcurrent = deps.slots ? deps.slots.maxConcurrent ?? getMaxConcurrent() : 1;
  const tasks: { task: import("@subbrain/core/db/tables/agent-tasks/types").AgentTaskRecord; acquired: boolean }[] = [];

  while (tasks.length < maxConcurrent) {
    const peeked = deps.pool.peekNextPending();
    if (!peeked) break;

    if (deps.slots) {
      const acquired = await deps.slots.tryAcquire(peeked.type);
      if (!acquired) break;
    }

    const claimed = deps.pool.claimById(peeked.id);
    if (!claimed) {
      deps.slots?.release(peeked.type);
      continue;
    }

    tasks.push({ task: claimed, acquired: true });

    if (deps.rateLimiter && !deps.rateLimiter.allow(claimed.type)) {
      deps.log.info("rate limit cooldown, skip", { meta: { type: claimed.type } });
      deps.pool.noop(claimed.id, "rate_limit_cooldown");
      deps.slots?.release(claimed.type);
      tasks.pop();
      break;
    }

    deps.log.info("task claimed", { meta: { id: claimed.id, type: claimed.type } });
  }

  if (tasks.length === 0) {
    deps.log.info("no pending tasks");
    return;
  }

  const results = await Promise.allSettled(
    tasks.map(({ task }) => runSingle(deps, task)),
  );

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "rejected") {
      deps.log.error("runFn rejected", { meta: { id: tasks[i].task.id, reason: String(r.reason) } });
      deps.pool.fail(tasks[i].task.id, String(r.reason));
      deps.slots?.release(tasks[i].task.type);
    }
  }
}

async function runSingle(
  deps: PoolDeps,
  task: import("@subbrain/core/db/tables/agent-tasks/types").AgentTaskRecord,
): Promise<void> {
  let result: Awaited<ReturnType<typeof deps.runFn>>;
  try {
    result = await deps.runFn(task);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    deps.log.error("runFn threw", { meta: { id: task.id, reason } });
    deps.pool.fail(task.id, reason);
    deps.slots?.release(task.type);
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
  deps.slots?.release(task.type);
}
