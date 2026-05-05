import { randomUUID } from "node:crypto";
import type { ContextRow } from "../../db";
import type { RAGPipeline } from "../../rag";
import type { MemoryRepository } from "../../repositories";
import { embedWithTimeout } from "./embed";
import type { InsertContextInput, ListOpts, PaginatedResult, UpdateContextPatch } from "./types";

export interface ContextDeps {
  repo: MemoryRepository;
  rag: RAGPipeline;
  listByStatus: (
    layer: "context",
    status: NonNullable<ListOpts["status"]>,
    limit: number,
    offset: number,
  ) => PaginatedResult<ContextRow>;
}

// B-1 note: MemoryService backs the admin /v1/memory/* routes — no agentId
// is threaded here, so search returns rows from every agent. The agent-loop
// reaches context through the registry's memory_search / rag_search handlers,
// which DO pass `ctx.agentId`.
export function listContext(deps: ContextDeps, opts: ListOpts): PaginatedResult<ContextRow> {
  const { repo } = deps;
  // MEM-6: `?active=true` → hide superseded/expired AND status!='active'.
  if (opts.q) {
    const filter = opts.active ? { activeOnly: true, notStale: true } : undefined;
    const hits = repo.searchContext(opts.q, opts.limit, filter);
    const items = hits.map((h) => repo.getContext(h.id)).filter((r): r is ContextRow => r !== null);
    return { items, total: items.length };
  }
  if (opts.status) return deps.listByStatus("context", opts.status, opts.limit, opts.offset);
  if (opts.active) return repo.listContextActive(opts.limit, opts.offset);
  return { items: repo.listContext(opts.limit, opts.offset), total: repo.countContext() };
}

export async function insertContext(deps: ContextDeps, input: InsertContextInput): Promise<string> {
  const id = randomUUID();
  const vec = await embedWithTimeout(deps.rag, input.content);
  if (!vec || vec.length === 0) throw new Error("embed_empty");
  deps.repo.transaction(() => {
    deps.repo.insertContext(
      id,
      input.title,
      input.content,
      input.tags ?? "",
      input.derivedFrom ?? [],
      input.agentId,
      {
        confidence: input.confidence ?? null,
        status: input.status,
        expires_at: input.expires_at ?? undefined,
      },
    );
    deps.repo.upsertEmbedding(id, "context", vec);
  });
  return id;
}

export function patchContext(
  repo: MemoryRepository,
  id: string,
  patch: UpdateContextPatch,
): ContextRow | null {
  repo.updateContext(id, patch);
  return repo.getContext(id);
}

// M-4 / MEM-4: pair row + vec deletion atomically.
export function deleteContext(repo: MemoryRepository, id: string): void {
  repo.transaction(() => {
    repo.deleteContext(id);
    repo.deleteEmbedding(id);
  });
}
