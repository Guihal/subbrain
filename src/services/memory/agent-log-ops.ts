import type { AgentMemRow, LogRow } from "@subbrain/core/db";
import type { LogRepository, MemoryRepository } from "@subbrain/core/repositories";
import type { ListOpts, PaginatedResult, UpdateAgentPatch } from "./types";

// ─── Agent memory ──────────────────────────────────────────
export function listAgent(repo: MemoryRepository, opts: ListOpts): PaginatedResult<AgentMemRow> {
  return {
    items: repo.listAllAgentMemories(opts.limit, opts.offset, opts.agentId),
    total: repo.countAgentMemories(opts.agentId),
  };
}

export function patchAgent(
  repo: MemoryRepository,
  id: string,
  patch: UpdateAgentPatch,
): AgentMemRow | null {
  repo.updateAgentMemory(id, patch);
  return repo.getAgentMemory(id);
}

// ─── Log (L4, read-only) ───────────────────────────────────
export function listLog(logRepo: LogRepository, opts: ListOpts): PaginatedResult<LogRow> {
  return {
    items: logRepo.listLog(opts.limit, opts.offset, opts.sessionId),
    total: logRepo.countLog(opts.sessionId),
  };
}
