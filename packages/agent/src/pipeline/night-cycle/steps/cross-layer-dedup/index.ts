import type { MemoryDB } from "@subbrain/core/db";
import type { MemoryService } from "../../../../services/memory";
import { readEnv, logDisabled, logDone } from "./config";
import { dedupPair, mostRecent } from "./dedup-pair";
import type { PairStat } from "./dedup-pair";
import { promoteArchiveToShared } from "./promote";
import { logger } from "@subbrain/core/lib/logger";
import { safeMessage } from "./config";

const log = logger.child("night.cross-layer");

export interface CrossLayerResult {
  pairs_examined: number;
  supersedes_added: number;
  promoted_to_shared: number;
  errors: number;
}

export interface CrossLayerDeps {
  memory: MemoryDB;
  memoryService: MemoryService;
}

export async function runCrossLayerDedup(deps: CrossLayerDeps): Promise<CrossLayerResult> {
  const cfg = readEnv();
  const r: CrossLayerResult = {
    pairs_examined: 0,
    supersedes_added: 0,
    promoted_to_shared: 0,
    errors: 0,
  };
  if (!cfg.enabled) {
    logDisabled();
    return r;
  }
  const ctx = mostRecent(deps.memory, "context", cfg.candidateLimit);
  const arc = mostRecent(deps.memory, "archive", cfg.candidateLimit);
  const shr = mostRecent(deps.memory, "shared", cfg.candidateLimit);
  const settled = await Promise.allSettled<PairStat>([
    Promise.resolve(dedupPair(deps.memory, ctx, arc)),
    Promise.resolve(dedupPair(deps.memory, arc, shr)),
    Promise.resolve(dedupPair(deps.memory, ctx, shr)),
  ]);
  for (const s of settled) {
    if (s.status === "fulfilled") {
      r.pairs_examined += s.value.pairs;
      r.supersedes_added += s.value.supersedes;
      r.errors += s.value.errors;
    } else {
      r.errors++;
      log.warn("pair failed", { meta: { msg: safeMessage(s.reason) } });
    }
  }
  const p = await promoteArchiveToShared(deps, cfg);
  r.promoted_to_shared = p.promoted;
  r.errors += p.errors;
  logDone(r.pairs_examined, r.supersedes_added, r.promoted_to_shared, r.errors);
  return r;
}
