import type { ArchiveRow } from "../../db";
import type { MemoryRepository } from "../../repositories";
import type { ListOpts, PaginatedResult, UpdateArchivePatch } from "./types";

export function listArchive(repo: MemoryRepository, opts: ListOpts): PaginatedResult<ArchiveRow> {
  if (opts.q) {
    const hits = repo.searchArchive(opts.q, opts.limit);
    const items = hits.map((h) => repo.getArchive(h.id)).filter((r): r is ArchiveRow => r !== null);
    return { items, total: items.length };
  }
  return { items: repo.listArchive(opts.limit, opts.offset), total: repo.countArchive() };
}

export function patchArchive(repo: MemoryRepository, id: string, patch: UpdateArchivePatch): ArchiveRow | null {
  repo.updateArchive(id, patch);
  return repo.getArchive(id);
}

// M-4 / MEM-4: pair row + vec deletion atomically.
export function deleteArchive(repo: MemoryRepository, id: string): void {
  repo.transaction(() => {
    repo.deleteArchive(id);
    repo.deleteEmbedding(id);
  });
}
