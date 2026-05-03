import { randomUUID } from "crypto";
import type { SharedRow } from "../../db";
import type { MemoryRepository } from "../../repositories";
import type { RAGPipeline } from "../../rag";
import { embedWithTimeout } from "./embed";
import type {
  InsertSharedInput,
  ListOpts,
  PaginatedResult,
  UpdateSharedPatch,
} from "./types";

export interface SharedDeps {
  repo: MemoryRepository;
  rag: RAGPipeline;
  /** Pending status filter (delegated back to repo via service.listByStatus). */
  listByStatus: (
    layer: "shared",
    status: NonNullable<ListOpts["status"]>,
    limit: number,
    offset: number,
  ) => PaginatedResult<SharedRow>;
}

export function listShared(deps: SharedDeps, opts: ListOpts): PaginatedResult<SharedRow> {
  const { repo } = deps;
  // MEM-6: `?active=true` → hide superseded/expired AND status!='active'.
  if (opts.q) {
    const filter = opts.active ? { activeOnly: true, notStale: true } : undefined;
    const hits = repo.searchShared(opts.q, opts.limit, filter);
    let items = hits.map((h) => repo.getShared(h.id)).filter((r): r is SharedRow => r !== null);
    // M-07: kind filter applied post-FTS (search doesn't index kind column).
    if (opts.kind) items = items.filter((r) => r.kind === opts.kind);
    return { items, total: items.length };
  }
  if (opts.status) return deps.listByStatus("shared", opts.status, opts.limit, opts.offset);
  if (opts.active) return repo.listSharedActive(opts.limit, opts.offset, opts.category);
  return {
    items: repo.listShared(opts.limit, opts.offset, opts.category, opts.kind),
    total: repo.countShared(opts.category, opts.kind),
  };
}

/** Embed-first then transactional insert+upsertEmbedding (§4). */
export async function insertShared(deps: SharedDeps, input: InsertSharedInput): Promise<string> {
  const id = randomUUID();
  const vec = await embedWithTimeout(deps.rag, input.content);
  if (!vec || vec.length === 0) throw new Error("embed_empty");
  deps.repo.transaction(() => {
    deps.repo.insertShared(
      id, input.category, input.content, input.tags ?? "", input.source,
      {
        confidence: input.confidence ?? null,
        status: input.status,
        kind: input.kind,
        expires_at: input.expires_at ?? undefined,
      },
    );
    deps.repo.upsertEmbedding(id, "shared", vec);
  });
  return id;
}

export function patchShared(repo: MemoryRepository, id: string, patch: UpdateSharedPatch): SharedRow | null {
  repo.updateShared(id, patch);
  return repo.getShared(id);
}

// M-4 / MEM-4: pair the row delete with vec delete so vec_embeddings never
// carries an orphan row. Wrapped in a transaction so a crash between the two
// leaves the DB consistent (no half-deleted entry).
export function deleteShared(repo: MemoryRepository, id: string): void {
  repo.transaction(() => {
    repo.deleteShared(id);
    repo.deleteEmbedding(id);
  });
}
